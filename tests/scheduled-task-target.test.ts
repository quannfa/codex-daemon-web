import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentDaemonThreadId, daemonThreadId, threadIdFromCodexLink, scheduledTaskInput, verifyDaemonThread } from "../server/scheduled-task-target.js";
import { ScheduledTaskStore, TaskValidationError, type ScheduledTask } from "../server/scheduled-tasks.js";
import type { AppServerRpc } from "../server/app-server-rpc.js";

const current = "01a1a5ef-2499-7f02-9d89-a6fc97feaace";
const other = "01a1a5ef-2499-7f02-9d89-a6fc97feaacf";
const bad = "conv_b8a22ffc89ff57dd6a334ead17ad7509";
const base = {name:"test",prompt:"No actions",mode:"sameChat",timezone:"Asia/Shanghai",schedule:{type:"daily",time:"19:50"}};
const saved = {...base,sourceThreadId:other,cwd:null,model:null,reasoningEffort:null} as ScheduledTask;
const now=()=>Date.parse("2026-11-04T12:00:00Z");

test("current target comes from transport UUID; conv IDs and missing metadata fail",()=>{
  assert.equal(currentDaemonThreadId({threadId:current,thread_id:other,session_id:bad}),current);
  assert.equal(currentDaemonThreadId({thread_id:current,session_id:bad}),current);
  assert.equal(currentDaemonThreadId({session_id:current}),current);
  assert.equal(currentDaemonThreadId({thread_id:current,session_id:other}),current);
  assert.equal(scheduledTaskInput(base,{thread_id:current}).threadId,current);
  assert.throws(()=>scheduledTaskInput(base,{session_id:bad}),/valid current daemon/);
  assert.throws(()=>scheduledTaskInput(base,{}),/Codex Link/);
  assert.throws(()=>scheduledTaskInput({...base,threadId:bad},{thread_id:current}),/no longer accepted/);
  assert.throws(()=>scheduledTaskInput({...base,threadId:other},{thread_id:current}),/no longer accepted/);
});
test("explicit targets require a Codex Link; never convert conv IDs to UUIDs",()=>{
  assert.equal(threadIdFromCodexLink("codex://threads/"+current),current);
  assert.equal(daemonThreadId(current.toUpperCase()),current);
  for(const link of [current,bad,"codex://threads/"+bad,"https://example.com/"+current,"codex://threads/"+current+"?x=1"]){
    assert.throws(()=>threadIdFromCodexLink(link));
  }
  assert.equal(scheduledTaskInput({...base,conversationLink:"codex://threads/"+other},{thread_id:current}).threadId,other);
  assert.throws(()=>scheduledTaskInput({...base,conversationLink:"codex://threads/"+other,useCurrentConversation:true},{thread_id:current}),/not both/);
});
test("partial updates preserve saved target; rebinding requires explicit intent",()=>{
  const partial=scheduledTaskInput({name:"new"}, {thread_id:current,cwd:"/another"}, saved);
  assert.equal(partial.threadId,other);
  assert.equal(partial.cwd,null);
  assert.equal(partial.prompt,saved.prompt);
  assert.deepEqual(partial.schedule,saved.schedule);
  assert.equal(scheduledTaskInput({useCurrentConversation:true},{thread_id:current},saved).threadId,current);
  assert.equal(scheduledTaskInput({conversationLink:"codex://threads/"+current},{},saved).threadId,current);
  assert.throws(()=>scheduledTaskInput({}, {}, {...saved,sourceThreadId:bad}),/UUID/);
  assert.equal(scheduledTaskInput({conversationLink:"codex://threads/"+current},{},{...saved,sourceThreadId:bad}).threadId,current);
  const fresh=scheduledTaskInput({...base,mode:"newChat",cwd:"/tmp"},{});
  assert.equal(fresh.threadId,undefined);
  assert.throws(()=>scheduledTaskInput({...base,mode:"newChat",conversationLink:"codex://threads/"+current},{}),/only to sameChat/);
});
test("verification reads metadata only and closes connection on success or error",async()=>{
  for(const failure of ["none","missing","mismatch"]){
    let closed=false;
    const calls:unknown[]=[];
    const connect=async()=>({
      call:async(method:string,params:unknown)=>{
        calls.push([method,params]);
        if(failure==="missing")throw Error("Thread not found");
        return {thread:{id:failure==="mismatch"?other:current}};
      },
      close:()=>{closed=true;},
    }) as unknown as AppServerRpc;
    if(failure==="none")await verifyDaemonThread(current,connect);
    else await assert.rejects(verifyDaemonThread(current,connect));
    assert.deepEqual(calls,[["thread/read",{threadId:current,includeTurns:false}]]);
    assert.equal(closed,true);
  }
});
test("all store entry points reject invalid/missing targets before persisting or scheduling",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"scheduled-target-"));
  try{
    const file=join(dir,"tasks.json");
    let reachable=true,reads=0;
    const store=new ScheduledTaskStore(file,now,async id=>{
      reads++;assert.equal(id,current);
      if(!reachable)throw Error("Thread not found");
    });
    await store.initialize();
    await assert.rejects(store.create({...base,threadId:bad}),TaskValidationError);
    assert.equal(reads,0);
    reachable=false;
    await assert.rejects(store.create({...base,threadId:current}),/Thread not found/);
    assert.equal((await store.list()).length,0);
    reachable=true;
    const task=await store.create({...base,threadId:current});
    const before=await readFile(file,"utf8");
    reachable=false;
    await assert.rejects(store.update(task.id,{...base,threadId:current,name:"changed"}),/Thread not found/);
    await assert.rejects(store.requestRunNow(task.id),/Thread not found/);
    assert.equal(await readFile(file,"utf8"),before);
    await store.setStatus(task.id,"paused");
    await assert.rejects(store.setStatus(task.id,"active"),/Thread not found/);
    assert.equal((await store.get(task.id)).status,"paused");
    reachable=true;
    await store.setStatus(task.id,"active");
    await store.requestRunNow(task.id);
    assert.equal((await store.get(task.id)).pendingManualRun,true);
    const count=reads;
    await store.create({...base,mode:"newChat",cwd:"/tmp"});
    assert.equal(reads,count);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("legacy failed task can be explicitly repaired without losing history or running it",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"scheduled-repair-"));
  try{
    const file=join(dir,"tasks.json");
    const seed=new ScheduledTaskStore(file,now,async()=>{});
    const old=await seed.create({...base,threadId:current});
    const data=JSON.parse(await readFile(file,"utf8"));
    data.tasks[0].sourceThreadId=bad;
    data.tasks[0].runs=[{id:"failed-run",status:"failed",threadId:bad,error:"invalid session id"}];
    await writeFile(file,JSON.stringify(data));
    const store=new ScheduledTaskStore(file,now,async id=>{assert.equal(id,current);});
    await assert.rejects(store.requestRunNow(old.id),/UUID/);
    const existing=await store.get(old.id);
    const input=scheduledTaskInput({conversationLink:"codex://threads/"+current},{},existing);
    const repaired=await store.update(old.id,input);
    assert.equal(repaired.sourceThreadId,current);
    assert.deepEqual(repaired.runs,existing.runs);
    assert.equal(repaired.prompt,existing.prompt);
    assert.equal(repaired.nextRunAt,existing.nextRunAt);
    assert.equal(repaired.pendingManualRun,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
