import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {randomUUID} from "node:crypto";
import express from "express";
import {ConversationShares} from "../server/conversation-shares";
import {SharedUploads,MAX_SHARED_UPLOAD_BYTES} from "../server/shared-uploads";
import {SharedConversationGateway,type SharedRpc,validateSharedMessage} from "../server/shared-conversation";
import {mountConversationShares} from "../server/share-routes";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOZkAAAAASUVORK5CYII=","base64");
async function fixture(t:any){
 const dir=await mkdtemp(join(tmpdir(),"codex-upload-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const shares=new ConversationShares(join(dir,"state","shares.json"));await shares.initialize();
 const created=await shares.create(randomUUID());const grant=shares.authenticate("Share "+created.token);
 const registry=join(dir,"state","uploads.json"),root=join(dir,"files");
 const uploads=new SharedUploads(registry,root,shares);await uploads.initialize();
 const calls:{method:string;params:any}[]=[];
 const rpc:SharedRpc={call:async<T>(method:string,params:any):Promise<T>=>{
  calls.push({method,params});assert.equal(params.threadId,grant.threadId);
  if(method==="thread/resume")return {thread:{id:grant.threadId}} as T;
  if(method==="thread/queue/add")return {queuedSubmission:{id:randomUUID()}} as T;
  throw Error("Unexpected RPC "+method);
 },close:()=>{}};
 const gateway=new SharedConversationGateway(shares,async()=>rpc,()=>undefined,uploads);t.after(()=>gateway.close());
 return {dir,shares,created,grant,registry,root,uploads,calls,gateway,rpc};
}
test("uploads retain original bytes, normalize names, deduplicate retries and survive restart",async t=>{
 const f=await fixture(t),id=randomUUID();
 const saved=await f.uploads.put(f.grant,id,"../../结果 图片.png",png);
 assert.equal(saved.kind,"image");assert.equal(saved.name,"结果 图片.png");
 assert.equal(saved.size,png.length);assert.ok(!("path" in saved));
 assert.deepEqual(await f.uploads.put(f.grant,id,"../../结果 图片.png",png),saved);
 await assert.rejects(f.uploads.put(f.grant,id,"different.png",png),{status:409});
 assert.equal((await readdir(join(f.root,f.grant.id))).length,1);
 const entries=JSON.parse(await readFile(f.registry,"utf8"));
 assert.ok(entries[0].path.startsWith(f.root));assert.deepEqual(await readFile(entries[0].path),png);
 assert.equal((await stat(entries[0].path)).mode&0o777,0o600);
 const restart=new SharedUploads(f.registry,f.root,f.shares);await restart.initialize();
 const input=await restart.input(f.grant,[id]);
 assert.equal(input[1].type,"localImage");assert.equal(input[1].path,entries[0].path);
 assert.ok(String(input[0].text).includes("purpose=\"input\""));
 await assert.rejects(restart.remove(f.grant,id),{status:409});
});
test("image-only and file messages enqueue fixed typed inputs and do not repeat on retry",async t=>{
 const f=await fixture(t),imageId=randomUUID(),fileId=randomUUID();
 await f.uploads.put(f.grant,imageId,"photo.png",png);
 await f.uploads.put(f.grant,fileId,"document.pdf",Buffer.from("%PDF-1.4\nfixture"));
 const requestId=randomUUID(),body={text:"",attachmentIds:[imageId,fileId],requestId};
 assert.equal((await f.gateway.send(f.grant,body)).status,"queued");
 assert.equal((await f.gateway.send(f.grant,body)).status,"queued");
 const queues=f.calls.filter(c=>c.method==="thread/queue/add");assert.equal(queues.length,1);
 assert.deepEqual(Object.keys(queues[0].params).sort(),["clientUserMessageId","input","threadId"]);
 assert.deepEqual(queues[0].params.input.map((x:any)=>x.type),["text","localImage","text"]);
 assert.ok(queues[0].params.input[2].text.includes("document.pdf"));
 await assert.rejects(f.gateway.send(f.grant,{...body,attachmentIds:[fileId]}),{status:409});
 const restart=new ConversationShares(join(f.dir,"state","shares.json"));await restart.initialize();
 const gateway=new SharedConversationGateway(restart,async()=>f.rpc,()=>undefined,f.uploads);t.after(()=>gateway.close());
 assert.equal((await gateway.send(f.grant,body)).status,"queued");
 assert.equal(f.calls.filter(c=>c.method==="thread/queue/add").length,1);
});
test("attachments cannot select targets or options, and other links cannot submit them",async t=>{
 const f=await fixture(t),id=randomUUID();
 await f.uploads.put(f.grant,id,"readme.txt",Buffer.from("data"));
 const second=await f.shares.create(randomUUID()),other=f.shares.authenticate("Share "+second.token);
 await assert.rejects(f.uploads.input(other,[id]),{status:404});
 for(const extra of [{threadId:other.threadId},{model:"change"},{approvalPolicy:"never"},{input:[{type:"localImage",path:"/etc/passwd"}]},{attachments:[{path:"/etc/passwd"}]}])
  assert.throws(()=>validateSharedMessage({text:"",attachmentIds:[id],requestId:randomUUID(),...extra}),{status:400});
 assert.throws(()=>validateSharedMessage({text:"",attachmentIds:[],requestId:randomUUID()}),{status:400});
 assert.throws(()=>validateSharedMessage({text:"",attachmentIds:[id,id],requestId:randomUUID()}),{status:400});
 await f.uploads.remove(f.grant,id);
 await assert.rejects(f.uploads.input(f.grant,[id]),{status:404});
 const id2=randomUUID();await f.uploads.put(f.grant,id2,"empty.txt",Buffer.alloc(0));
 await f.shares.revoke(f.grant.id);
 await assert.rejects(f.uploads.put(f.grant,randomUUID(),"new.txt",Buffer.from("x")),{status:401});
 await assert.rejects(f.uploads.input(f.grant,[id2]),{status:401});
});
test("raw upload API authenticates before accepting bytes and supports remove and attachment-only send",async t=>{
 const f=await fixture(t),app=express();app.use(express.json({limit:"64kb"}));
 mountConversationShares(app,f.shares,f.gateway,
  (_req,res)=>void res.sendStatus(401),
  (req,res,next)=>req.headers.origin==="http://test"?next():void res.sendStatus(403),
  undefined,f.uploads);
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const base="http://127.0.0.1:"+(server.address() as any).port;
 const headers={authorization:"Share "+f.created.token,origin:"http://test","content-type":"application/octet-stream","x-file-name":encodeURIComponent("表格.csv")};
 const id=randomUUID(),url=base+"/api/shared/uploads/"+id;
 assert.equal((await fetch(url,{method:"POST",body:"data",headers:{...headers,authorization:""}})).status,401);
 assert.equal((await fetch(url,{method:"POST",body:"data",headers:{...headers,origin:"http://evil"}})).status,403);
 assert.equal((await fetch(url+"?threadId="+randomUUID(),{method:"POST",body:"data",headers})).status,400);
 const response=await fetch(url,{method:"POST",body:"a,b\n1,2",headers});
 assert.equal(response.status,201);assert.equal((await response.json()).kind,"file");
 assert.equal((await fetch(url,{method:"POST",body:"a,b\n1,2",headers})).status,201);
 const message=await fetch(base+"/api/shared/messages",{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({text:"",requestId:randomUUID(),attachmentIds:[id]})});
 assert.equal(message.status,202);
 assert.equal((await fetch(url,{method:"DELETE",headers})).status,409);
 const id2=randomUUID(),second=base+"/api/shared/uploads/"+id2;
 assert.equal((await fetch(second,{method:"POST",body:png,headers:{...headers,"x-file-name":"screenshot.png"}})).status,201);
 assert.equal((await fetch(second,{method:"DELETE",headers})).status,200);
 assert.equal((await fetch(second,{method:"POST",body:Buffer.alloc(MAX_SHARED_UPLOAD_BYTES+1),headers})).status,413);
 await f.shares.revoke(f.grant.id);
 assert.equal((await fetch(url,{method:"POST",body:"data",headers})).status,401);
});

test("draft expiry removes only old unsent files and never deletes submitted history",async t=>{
 const f=await fixture(t),draft=randomUUID(),sent=randomUUID();
 await f.uploads.put(f.grant,draft,"draft.txt",Buffer.from("draft"));
 await f.uploads.put(f.grant,sent,"sent.txt",Buffer.from("keep"));
 await f.uploads.input(f.grant,[sent]);
 const state=JSON.parse(await readFile(f.registry,"utf8"));
 for(const row of state)row.createdAt=Date.now()-2*86400_000;
 await writeFile(f.registry,JSON.stringify(state));
 const restart=new SharedUploads(f.registry,f.root,f.shares);await restart.initialize();
 await assert.rejects(stat(state.find((u:any)=>u.id===draft).path),{code:"ENOENT"});
 assert.equal(await readFile(state.find((u:any)=>u.id===sent).path,"utf8"),"keep");
 const bad=state.map((row:any)=>({...row,path:"/outside-managed-uploads/file.txt"}));
 await writeFile(f.registry,JSON.stringify(bad));
 await assert.rejects(new SharedUploads(f.registry,f.root,f.shares).initialize(),/Invalid shared upload registry/);
});
