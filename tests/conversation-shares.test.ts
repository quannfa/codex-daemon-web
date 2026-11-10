import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readFile,writeFile,mkdir,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import express from "express";
import {ConversationShares} from "../server/conversation-shares";
import {SharedConversationGateway,sharedMessages,type SharedRpc} from "../server/shared-conversation";
import {AppServerRpcError} from "../server/app-server-rpc";
import {ResourceStore} from "../server/resources";
import {mountConversationShares} from "../server/share-routes";

async function fixture(t:any){
 const dir=await mkdtemp(join(tmpdir(),"codex-share-test-"));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,"shares.json");let now=Date.now();
 const store=new ConversationShares(path,()=>now);await store.initialize();
 const threadId=randomUUID();const created=await store.create(threadId);
 const grant=store.authenticate("Share "+created.token);
 return {store,path,threadId,created,grant,advance:(ms:number)=>{now+=ms;}};
}
function fake(threadId:string){
 const calls:{method:string;params:any}[]=[];
 const rpc:SharedRpc={
  call:async<T>(method:string,params:any):Promise<T>=>{
   calls.push({method,params});
   assert.equal(params.threadId,threadId);
   if(method==="thread/read"||method==="thread/resume")return {thread:{id:threadId,name:"Shared test",cwd:"/private",model:"private-model",status:{type:"idle"}}} as T;
   if(method==="thread/items/list")return {data:[
    {turnId:"turn",item:{id:"a",type:"agentMessage",text:"world"},startedAtMs:1794126940000,completedAtMs:1794126945000},
    {turnId:"turn",item:{id:"tool",type:"commandExecution",command:"secret"},startedAtMs:1794126930000,completedAtMs:1794126935000},
    {turnId:"turn",item:{id:"u",type:"userMessage",content:[{type:"text",text:"hello"},{type:"image",url:"private"}]},startedAtMs:1794126920000,completedAtMs:1794126920000},
   ],nextCursor:"daemon-cursor"} as T;
   if(method==="thread/queue/list")return {data:[]} as T;
   if(method==="thread/queue/add")return {queuedSubmission:{id:"submission"}} as T;
   throw Error("Unexpected method "+method);
  },close:()=>{},
 };
 return {calls,rpc};
}
test("share credentials are hashed, persistent, scoped, expiring and revocable",async t=>{
 const f=await fixture(t);
 const disk=await readFile(f.path,"utf8");
 assert.ok(!disk.includes(f.created.token.split(".")[1]));
 assert.equal((await stat(f.path)).mode&0o777,0o600);
 const restart=new ConversationShares(f.path);await restart.initialize();
 assert.equal(restart.authenticate("Share "+f.created.token).threadId,f.threadId);
 assert.throws(()=>f.store.authenticate("Bearer "+f.created.token),{status:401});
 assert.throws(()=>f.store.authenticate("Share "+f.created.id+"."+"x".repeat(43)),{status:401});
 const second=await f.store.create(randomUUID());
 assert.throws(()=>f.store.authenticate("Share "+second.id+"."+f.created.token.split(".")[1]),{status:401});
 const cursor=f.store.cursor(f.grant,"opaque cursor");
 assert.equal(f.store.readCursor(f.grant,cursor),"opaque cursor");
 assert.throws(()=>f.store.readCursor(f.store.authenticate("Share "+second.token),cursor),{status:400});
 await f.store.revoke(second.id);
 assert.throws(()=>f.store.authenticate("Share "+second.token),{status:401});
 f.advance(7*86400_000);
 assert.throws(()=>f.store.authenticate("Share "+f.created.token),{status:401});
 await assert.rejects(f.store.create(f.threadId,0),{status:400});
});
test("guest history includes attachments and tool logs without configuration APIs",async t=>{
 const f=await fixture(t),mock=fake(f.threadId);
 const gateway=new SharedConversationGateway(f.store,async()=>mock.rpc,()=>undefined);t.after(()=>gateway.close());
 const snapshot=await gateway.read(f.grant,undefined);
 assert.deepEqual(snapshot.messages.map(m=>m.role),["user","activity","assistant"]);
 assert.equal(snapshot.messages[0].content?.[1].type,"image");
 assert.equal(snapshot.messages[1].item?.command,"secret");
 assert.equal(snapshot.messages[2].text,"world");
 assert.equal(snapshot.cwd,"/private");
 assert.ok(!JSON.stringify(snapshot).includes("private-model"));
 assert.ok(snapshot.olderCursor);
 assert.deepEqual(snapshot.messages.map(m=>m.startedAtMs),[1794126920000,1794126930000,1794126940000]);
 assert.equal(snapshot.messages[2].completedAtMs,1794126945000);
 assert.deepEqual(mock.calls.find(c=>c.method==="thread/items/list")?.params,{threadId:f.threadId,limit:100,sortDirection:"desc"});
 const repeated=await gateway.read(f.grant,undefined);
 assert.deepEqual(repeated.messages,snapshot.messages);
 await gateway.read(f.grant,snapshot.olderCursor);
 assert.equal(mock.calls.filter(c=>c.method==="thread/items/list").at(-1)?.params.cursor,"daemon-cursor");
 assert.equal(mock.calls.filter(c=>c.method==="thread/queue/list").length,2);
});
test("guest sends only fixed queue parameters, rejects option overrides and deduplicates after restart",async t=>{
 const f=await fixture(t),mock=fake(f.threadId);
 const gateway=new SharedConversationGateway(f.store,async()=>mock.rpc,()=>undefined);t.after(()=>gateway.close());
 for(const field of ["threadId","model","config","approvalPolicy","cwd","sandboxPolicy"]){
  await assert.rejects(gateway.send(f.grant,{text:"hello",requestId:randomUUID(),[field]:"override"}),{status:400});
 }
 assert.equal(mock.calls.length,0);
 const body={text:"hello",requestId:randomUUID()};
 assert.equal((await gateway.send(f.grant,body)).status,"queued");
 assert.equal((await gateway.send(f.grant,body)).status,"queued");
 const queued=mock.calls.filter(c=>c.method==="thread/queue/add");
 assert.equal(queued.length,1);
 assert.deepEqual(Object.keys(queued[0].params).sort(),["clientUserMessageId","input","threadId"]);
 assert.deepEqual(mock.calls.find(c=>c.method==="thread/resume")?.params,{threadId:f.threadId,excludeTurns:true});
 const restart=new ConversationShares(f.path);await restart.initialize();
 const again=new SharedConversationGateway(restart,async()=>mock.rpc,()=>undefined);t.after(()=>again.close());
 assert.equal((await again.send(restart.authenticate("Share "+f.created.token),body)).status,"queued");
 assert.equal(mock.calls.filter(c=>c.method==="thread/queue/add").length,1);
 await assert.rejects(gateway.send(f.grant,{...body,text:"changed"}),{status:409});
 await f.store.revoke(f.grant.id);
 await assert.rejects(gateway.send(f.grant,{text:"revoked",requestId:randomUUID()}),{status:401});
});
test("lost acknowledgements and interrupted submissions cannot enqueue duplicates",async t=>{
 const f=await fixture(t),mock=fake(f.threadId);let submissions=0;
 const call=mock.rpc.call;
 mock.rpc.call=async<T>(method:string,params:any):Promise<T>=>{
  if(method==="thread/queue/add"){submissions++;throw Error("connection lost");}
  return call<T>(method,params);
 };
 const gateway=new SharedConversationGateway(f.store,async()=>mock.rpc,()=>undefined);t.after(()=>gateway.close());
 const body={text:"hello",requestId:randomUUID()};
 assert.equal((await gateway.send(f.grant,body)).status,"uncertain");
 assert.equal((await gateway.send(f.grant,body)).status,"uncertain");
 assert.equal(submissions,1);
 const interrupted=randomUUID();await f.store.reserve(f.grant,interrupted,"interrupted");
 const restart=new ConversationShares(f.path);await restart.initialize();
 assert.equal((await restart.reserve(f.grant,interrupted,"interrupted")).receipt.state,"uncertain");
});
test("revocation while reading or resuming prevents response disclosure or queue submission",async t=>{
 const f=await fixture(t),mock=fake(f.threadId),call=mock.rpc.call;
 mock.rpc.call=async<T>(method:string,params:any):Promise<T>=>{
  const result=await call<T>(method,params);
  if(method==="thread/queue/list")await f.store.revoke(f.grant.id);
  return result;
 };
 const gateway=new SharedConversationGateway(f.store,async()=>mock.rpc,()=>undefined);t.after(()=>gateway.close());
 await assert.rejects(gateway.read(f.grant,undefined),{status:401});
 const second=await f.store.create(f.threadId),grant=f.store.authenticate("Share "+second.token);
 mock.rpc.call=async<T>(method:string,params:any):Promise<T>=>{
  const result=await call<T>(method,params);
  if(method==="thread/resume")await f.store.revoke(grant.id);
  return result;
 };
 await assert.rejects(gateway.send(grant,{text:"hello",requestId:randomUUID()}),{status:401});
 assert.equal(mock.calls.filter(c=>c.method==="thread/queue/add").length,0);
});
test("routes isolate owner controls, reject foreign origins and thread selectors, revoke access",async t=>{
 const f=await fixture(t),mock=fake(f.threadId);
 const gateway=new SharedConversationGateway(f.store,async()=>mock.rpc,()=>undefined);t.after(()=>gateway.close());
 const app=express();app.use(express.json());
 mountConversationShares(app,f.store,gateway,
  (req,res,next)=>req.headers.authorization==="owner"?next():void res.sendStatus(401),
  (req,res,next)=>req.headers.origin==="http://test"?next():void res.sendStatus(403));
 const server=app.listen(0,"127.0.0.1");
 await new Promise<void>(resolve=>server.once("listening",resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const base="http://127.0.0.1:"+(server.address() as any).port;
 const headers={authorization:"Share "+f.created.token,origin:"http://test","content-type":"application/json"};
 assert.equal((await fetch(base+"/api/shared/conversation",{headers})).status,200);
 assert.equal((await fetch(base+"/api/shared/conversation?threadId="+randomUUID(),{headers})).status,400);
 assert.equal((await fetch(base+"/api/shared/conversation")).status,401);
 assert.equal((await fetch(base+"/api/shares?threadId="+f.threadId,{headers})).status,401);
 assert.equal((await fetch(base+"/api/shares",{method:"POST",headers,body:JSON.stringify({threadId:f.threadId})})).status,401);
 assert.equal((await fetch(base+"/api/shares/"+f.grant.id,{method:"DELETE",headers})).status,401);
 assert.equal((await fetch(base+"/api/shared/messages",{method:"POST",headers:{...headers,origin:"http://evil"},body:"{}"})).status,403);
 assert.equal((await fetch(base+"/api/shared/messages",{method:"POST",headers,body:JSON.stringify({text:"hello",requestId:randomUUID(),threadId:randomUUID()})})).status,400);
 assert.equal((await fetch(base+"/api/shared/messages",{method:"POST",headers,body:JSON.stringify({text:"hello",requestId:randomUUID()})})).status,202);
 assert.equal((await fetch(base+"/api/shares/"+f.grant.id,{method:"DELETE",headers:{...headers,authorization:"owner"}})).status,200);
 assert.equal((await fetch(base+"/api/shared/conversation",{headers})).status,401);
});

test("new saved threads show empty history; ephemeral threads cannot be shared",async t=>{
 const f=await fixture(t),mock=fake(f.threadId),call=mock.rpc.call;
 mock.rpc.call=async<T>(method:string,params:any):Promise<T>=>{
  if(method==="thread/items/list")throw new AppServerRpcError(method,"thread is not materialized yet; thread/items/list is unavailable before first user message",true,false);
  return call<T>(method,params);
 };
 const gateway=new SharedConversationGateway(f.store,async()=>mock.rpc,()=>undefined);t.after(()=>gateway.close());
 assert.deepEqual((await gateway.read(f.grant,undefined)).messages,[]);
 mock.rpc.call=async<T>():Promise<T>=>({thread:{id:f.threadId,ephemeral:true}} as T);
 await assert.rejects(gateway.verify(f.threadId),{status:400});
});

test("shared resources reuse owner file permissions, allow outside projects, and require live grants",async t=>{
 const f=await fixture(t),mock=fake(f.threadId);
 const gateway=new SharedConversationGateway(f.store,async()=>mock.rpc,()=>undefined);t.after(()=>gateway.close());
 const root=join(f.path,"..","files");await mkdir(root);
 const file=join(root,"outside-project.txt");await writeFile(file,"shared attachment");
 const nested=join(root,"nested.md");await writeFile(nested,"# Nested");
 const resources=new ResourceStore(join(f.path,"..","resource-state","resources.json"));await resources.initialize();
 const app=express();app.use(express.json());
 const owner:express.RequestHandler=(req,res,next)=>req.headers.authorization==="owner"?next():void res.sendStatus(401);
 const origin:express.RequestHandler=(req,res,next)=>req.headers.origin==="http://test"?next():void res.sendStatus(403);
 mountConversationShares(app,f.store,gateway,owner,origin,resources);
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const base="http://127.0.0.1:"+(server.address() as any).port;
 const headers={authorization:"Share "+f.created.token,origin:"http://test","content-type":"application/json"};
 const register=(body:any,h=headers)=>fetch(base+"/api/shared/resources",{method:"POST",headers:h,body:JSON.stringify(body)});
 const response=await register({path:file});assert.equal(response.status,200);
 const info=await response.json();const url=base+"/api/shared/resources/"+info.id+"/"+info.name;
 const content=await fetch(url,{headers});assert.equal(content.status,200);assert.equal(await content.text(),"shared attachment");
 assert.equal(content.headers.get("cache-control"),"no-store");
 assert.equal((await register({path:"nested.md",baseResourceId:info.id})).status,200);
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url,{headers:{authorization:"owner"}})).status,401);
 assert.equal((await register({path:file,threadId:randomUUID()})).status,400);
 assert.equal((await register({path:file},{...headers,origin:"http://evil"})).status,403);
 await writeFile(join(root,".env"),"secret");
 assert.equal((await register({path:join(root,".env")})).status,403);
 const ranged=await fetch(url,{headers:{...headers,range:"bytes=0-5"}});assert.equal(ranged.status,206);assert.equal(await ranged.text(),"shared");
 await f.store.revoke(f.grant.id);
 assert.equal((await register({path:file})).status,401);assert.equal((await fetch(url,{headers})).status,401);
 const second=await f.store.create(f.threadId);
 const registerOriginal=resources.register.bind(resources);
 resources.register=async input=>{
  const result=await registerOriginal(input);
  await f.store.revoke(second.id);
  return result;
 };
 assert.equal((await register({path:file},{...headers,authorization:"Share "+second.token})).status,401);
});


test("shared history preserves per-message milliseconds, order and missing legacy timestamps",()=>{
 const result=sharedMessages([
  {turnId:"turn",startedAtMs:1794126940000,completedAtMs:1794126945000,item:{id:"final",type:"agentMessage",text:"Finished"}},
  {turnId:"turn",startedAtMs:1794126920000,completedAtMs:null,item:{id:"progress",type:"agentMessage",text:"Working"}},
  {turnId:"turn",startedAtMs:null,completedAtMs:1794126910000,item:{id:"user",type:"userMessage",content:[{type:"text",text:"Go"}]}},
  {turnId:"old",item:{id:"user",type:"userMessage",content:[{type:"text",text:"Legacy"}]}},
 ]);
 assert.deepEqual(result.map(m=>m.id),["old:user","turn:user","turn:progress","turn:final"]);
 assert.deepEqual(result.map(m=>[m.startedAtMs,m.completedAtMs]),[
  [null,null],[null,1794126910000],[1794126920000,null],[1794126940000,1794126945000],
 ]);
 const reasoning=sharedMessages([{turnId:"turn",item:{id:"reasoning",type:"reasoning",summary:["Summary"],content:["Private details"]}}]);
 assert.equal(reasoning[0].item?.content,undefined);
 assert.deepEqual(reasoning[0].item?.summary,["Summary"]);
});


test("empty saved threads with an unsupported items endpoint are confirmed before returning empty history",async t=>{
 const f=await fixture(t),mock=fake(f.threadId),call=mock.rpc.call;
 const unsupported=new AppServerRpcError("thread/items/list","thread/items/list is not supported yet",true,false);
 let empty=true,probes=0;
 mock.rpc.call=async<T>(method:string,params:any):Promise<T>=>{
  if(method==="thread/items/list")throw unsupported;
  if(method==="thread/turns/list"){
   probes++;
   assert.deepEqual(params,{threadId:f.threadId,limit:1,itemsView:"notLoaded"});
   if(empty)throw new AppServerRpcError(method,"thread is not materialized yet; thread/turns/list is unavailable before first user message",true,false);
   return {data:[{id:"turn"}]} as T;
  }
  return call<T>(method,params);
 };
 const gateway=new SharedConversationGateway(f.store,async()=>mock.rpc,()=>undefined);t.after(()=>gateway.close());
 assert.deepEqual((await gateway.read(f.grant,undefined)).messages,[]);
 assert.equal(probes,1);
 empty=false;
 await assert.rejects(gateway.read(f.grant,undefined),unsupported);
 assert.equal(probes,2);
 await assert.rejects(gateway.read(f.grant,f.store.cursor(f.grant,"older-cursor")),unsupported);
 assert.equal(probes,2);
});
