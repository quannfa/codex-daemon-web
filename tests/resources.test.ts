import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { ResourceStore, mountResources } from "../server/resources";
import { localReferencePath, safeMarkdownUrl } from "../client/resource-paths";

test("resource paths handle Unicode, spaces, line numbers, and reject active schemes",()=>{
 assert.equal(localReferencePath("图片/结果 图.png","/project/docs"),"/project/docs/图片/结果 图.png");
 assert.equal(localReferencePath("../plot.png","/project/docs"),"/project/plot.png");
 assert.equal(localReferencePath("file:///project/a%20b.md#L10","/"),"/project/a b.md");
 assert.equal(localReferencePath("/project/a.ts:10:2","/"),"/project/a.ts");
 for(const value of ["javascript:alert(1)","file://other/project/a","//evil/a","#heading","data:text/html,hello"])assert.equal(localReferencePath(value,"/project"),null);
 assert.equal(safeMarkdownUrl("资料/报告.md"),"资料/报告.md");
 assert.equal(safeMarkdownUrl("javascript:alert(1)"),"");
 assert.equal(safeMarkdownUrl("data:text/html,hello"),"");
});

test("resources allow readable files outside projects while protecting credentials and login",async()=>{
 const temp=await mkdtemp(join(tmpdir(),"codex-resources-test-"));
 const project=join(temp,"project"),state=join(temp,"state","resources.json");
 await mkdir(project); const path=join(project,"报告 a.txt");await writeFile(path,"0123456789");
 const outside=join(temp,"secret.txt");await writeFile(outside,"private");
 const store=new ResourceStore(state);await store.initialize();
 const info=await store.register({path});assert.equal(info.size,10);
 await assert.rejects(store.register({path:project}),/regular file/);
 const officialProject=join(temp,".codex",".chatgpt-projects","example");await mkdir(officialProject,{recursive:true});await writeFile(join(officialProject,"report.md"),"# Report");
 const officialStore=new ResourceStore(join(temp,"official-state","registry.json"));await officialStore.initialize();assert.equal((await officialStore.register({path:join(officialProject,"report.md")})).kind,"markdown");
 await writeFile(join(project,"locked.txt"),"locked",{mode:0o000});await assert.rejects(store.register({path:join(project,"locked.txt")}),{code:"EACCES"});

 assert.equal((await store.register({path:outside})).path,outside);
 await writeFile(join(project,".env"),"secret");await assert.rejects(store.register({path:join(project,".env")}),/not available/);
 await symlink(outside,join(project,"escape.txt"));assert.equal((await store.register({path:join(project,"escape.txt")})).name,"escape.txt");
 await symlink(path,join(project,"inside.txt"));const linked=await store.register({path:join(project,"inside.txt")});
 await unlink(join(project,"inside.txt"));await symlink(join(project,".env"),join(project,"inside.txt"));await assert.rejects(store.open(linked.id),/not available/);
 await assert.rejects(store.register({path:state}),/not available/);
 await assert.rejects(store.register({path:"/proc/self/environ"}),/not available/);
 const restarted=new ResourceStore(state);await restarted.initialize();
 const app=express();app.use(express.json());
 mountResources(app,restarted,(req,res,next)=>req.headers.authorization==="test"?next():void res.sendStatus(401),(req,res,next)=>req.headers.origin==="http://test"?next():void res.sendStatus(403));
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
 const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
 const url=base+"/api/resources/"+info.id+"/"+encodeURIComponent(info.name);
 try {
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(base+"/api/resources",{method:"POST",headers:{authorization:"test","content-type":"application/json"},body:JSON.stringify({path})})).status,403);
  const response=await fetch(url,{headers:{authorization:"test",range:"bytes=2-5"}});
  assert.equal(response.status,206);assert.equal(response.headers.get("content-range"),"bytes 2-5/10");assert.equal(await response.text(),"2345");
  const head=await fetch(url,{method:"HEAD",headers:{authorization:"test"}});assert.equal(head.status,200);assert.equal(head.headers.get("content-length"),"10");
  assert.equal((await fetch(url,{headers:{authorization:"test",range:"bytes=99-"}})).status,416);
  const suffix=await fetch(url,{headers:{authorization:"test",range:"bytes=-3"}});assert.equal(await suffix.text(),"789");
  const full=await fetch(url,{headers:{authorization:"test"}});assert.equal(await full.text(),"0123456789");
  const unchanged=await fetch(url,{headers:{authorization:"test","if-none-match":full.headers.get("etag")!}});assert.equal(unchanged.status,304);
  await writeFile(path,"updated");assert.equal(await (await fetch(url,{headers:{authorization:"test"}})).text(),"updated");
  const download=await fetch(url+"?download=1",{headers:{authorization:"test"}});assert.match(download.headers.get("content-disposition")!,/^attachment/);
  await unlink(path);assert.equal((await fetch(url,{headers:{authorization:"test"}})).status,404);
  const records=JSON.parse(await readFile(state,"utf8"));assert.ok(records.every((r:Record<string,unknown>)=>Object.keys(r).sort().join(",")==="id,path"));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(temp,{recursive:true,force:true});}
});

test("legacy resource IDs remain valid after removing project scopes",async()=>{
 const temp=await mkdtemp(join(tmpdir(),"codex-legacy-resources-"));
 try {
  const state=join(temp,"state","resources.json");await mkdir(join(temp,"state"));
  const path=join(temp,"outside-report.md");await writeFile(path,"# Report");
  const id="1".repeat(32);await writeFile(state,JSON.stringify([{id,path,root:join(temp,"removed-project")}]))
  const store=new ResourceStore(state);await store.initialize();
  assert.equal((await store.register({path})).id,id);
  const opened=await store.open(id);assert.equal(await opened.file.readFile("utf8"),"# Report");await opened.file.close();
  const remote=new ResourceStore(join(temp,"remote-state","resources.json"),false);await remote.initialize();
  await assert.rejects(remote.register({path}),/local daemon/);
 }finally{await rm(temp,{recursive:true,force:true});}
});
