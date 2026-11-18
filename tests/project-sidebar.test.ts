import assert from "node:assert/strict";
import test from "node:test";
import {
  groupSidebarThreads, readProjectPreferences, buildAgentTreeRows, buildProjectCreateParams,
  agentParentId, agentDisplayName, branchSelection, readStateGroups, type CodexProject,
} from "../client/project-sidebar";
import type { ThreadSummary } from "../client/types";

const thread = (id: string, cwd: string, projectId: string | null,
  recencyAt: number | null = 10, updatedAt = 5): ThreadSummary =>
  ({ id, cwd, projectId, recencyAt, updatedAt, createdAt: 1, preview: id } as ThreadSummary);
const projects: CodexProject[] = [
  {id:"p1",name:"Same Name",roots:[{path:"/a"}],recencyAt:null},
  {id:"p2",name:"Same Name",roots:[{path:"/b"}],recencyAt:null},
];
const group = (threads: ThreadSummary[], sort:"recent"|"name"="recent", archived=false,
  view:"projects"|"status"="projects") =>
  groupSidebarThreads(threads,projects,sort,archived,view,t=>t.id==="error"?"error":"idle");

test("groups by canonical project ID regardless of cwd, preserves name collisions",()=>{
  const source=[
    thread("a","/unrelated","p1"),
    thread("b","/a","p2"),
    thread("c","/a","p1"),
    thread("d","/a",null),
    thread("e","/b","unknown"),
  ];
  const before=source.map(t=>t.cwd);
  const grouped=group(source);
  assert.equal(grouped.length,3);
  assert.deepEqual(grouped.find(g=>g.projectId==="p1")?.threads.map(t=>t.id),["a","c"]);
  assert.deepEqual(grouped.find(g=>g.projectId==="p2")?.threads.map(t=>t.id),["b"]);
  assert.deepEqual(grouped.find(g=>g.kind==="unassigned")?.threads.map(t=>t.id),["d","e"]);
  assert.deepEqual(source.map(t=>t.cwd),before);
});

test("sorting is stable, uses recency for active threads and updatedAt for archived",()=>{
  const source=[thread("old","/a","p1",1,30),thread("new","/a","p1",20,2),
    thread("other","/b","p2",10,10)];
  assert.deepEqual(group(source)[0].threads.map(t=>t.id),["new","old"]);
  assert.deepEqual(group(source,"recent",true)[0].threads.map(t=>t.id),["old","new"]);
  assert.deepEqual(group(source,"name").map(g=>g.projectId),["p1","p2"]);
});

test("status view groups by status and ignores project membership",()=>{
  const result=group([thread("error","/a","p1"),thread("ok","/b","p2")],"recent",false,"status");
  assert.deepEqual(result.map(g=>g.cwd),["status:error","status:idle"]);
  assert.deepEqual(result.map(g=>g.threads[0].id),["error","ok"]);
});

test("reads preferences defensively and handles blocked storage",()=>{
  const read=(value:string|null)=>readProjectPreferences({getItem:()=>value});
  assert.equal(read(null).view,"projects");
  assert.deepEqual(read("{"),{collapsed:{},sort:"recent",view:"projects",unreadOnly:false});
  assert.deepEqual(readProjectPreferences({getItem:()=>{throw Error("denied");}}),
    {collapsed:{},sort:"recent",view:"projects",unreadOnly:false});
  const stored=read("{\"sort\":\"name\",\"view\":\"status\",\"collapsed\":{\"p1\":true,\"invalid\":\"yes\"}}");
  assert.equal(stored.sort,"name");
  assert.equal(stored.view,"status");
  assert.equal(stored.collapsed.p1,true);
  assert.equal(stored.collapsed.invalid,undefined);
  assert.equal(read('{"view":"read-state","unreadOnly":true}').view,"read-state");
  assert.equal(read('{"view":"read-state","unreadOnly":true}').unreadOnly,true);
  assert.equal(read('{"view":"other","unreadOnly":"true"}').unreadOnly,false);
});

test("nested child agent tree respects collapsed state and subagent metadata",()=>{
  const root=thread("root","/root","p1");
  const agent=thread("agent","/root","p1");
  (agent as any).source={subAgent:{thread_spawn:{parent_thread_id:"root",agent_nickname:"Researcher"}}};
  assert.equal(agentParentId(agent),"root");
  assert.equal(agentDisplayName(agent),"Researcher");
  assert.deepEqual(buildAgentTreeRows([root],[agent],{},false).map(row=>row.depth),[0,1]);
  assert.deepEqual(buildAgentTreeRows([root],[agent],{root:true},false).map(row=>row.depth),[0]);
});

test("read states keep project and ancestor paths; unread descendants do not count as unread parents",()=>{
  const root=thread("root","/root","p1");
  const parent={...thread("parent","/root","p1"),parentThreadId:root.id};
  const child={...thread("child","/root","p1"),parentThreadId:parent.id};
  const sibling={...thread("sibling","/root","p1"),parentThreadId:parent.id};
  const alone=thread("alone","/other","p2");
  const orphan={...thread("orphan","/root","p1"),parentThreadId:"not-loaded"};
  const roots=[root,alone];
  const agents=[parent,child,sibling,orphan];
  const unreadIds=new Set([child.id,alone.id,orphan.id]);
  const candidates=new Set([...roots,...agents].map(t=>t.id));
  const [unread,read]=readStateGroups(roots,agents,candidates,unreadIds,projects,"name",false);
  assert.deepEqual([...unread.matchedIds],[alone.id,child.id]);
  assert.deepEqual(unread.groups.map(g=>g.projectId),["p1","p2"]);
  assert.deepEqual([...read.matchedIds],[root.id,parent.id,sibling.id]);
  assert.deepEqual(read.groups.map(g=>g.projectId),["p1"]);
  assert.equal(unread.descendantCounts.get(root.id),1);
  assert.equal(unread.descendantCounts.get(parent.id),1);
  assert.deepEqual(buildAgentTreeRows([root],agents,{},false,"",unread.visibleIds).map(r=>r.thread.id),[root.id,parent.id,child.id]);
  assert.deepEqual(buildAgentTreeRows([root],agents,{[parent.id]:true},false,"",unread.visibleIds).map(r=>r.thread.id),[root.id,parent.id]);
  const missing=branchSelection([],agents,unreadIds);
  assert.equal(missing.matchedIds.size,0);
  assert.equal(missing.visibleIds.size,0);
});

test("builds an official Codex project/create request with a stable idempotency key",()=>{
  assert.deepEqual(buildProjectCreateParams("  New research  ","  /data/research  ","stable-key"),{
    name:"New research",roots:[{path:"/data/research"}],idempotencyKey:"stable-key",
  });
  assert.throws(()=>buildProjectCreateParams("  ","/data/research","key"),/name is required/i);
  assert.throws(()=>buildProjectCreateParams("Research","relative/path","key"),/absolute path/i);
  assert.throws(()=>buildProjectCreateParams("Research","/data/research",""),/idempotency key/i);
});
