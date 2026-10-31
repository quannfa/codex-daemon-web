import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentReturnLoop } from "./subagent-return-loop.js";
import { claimThreadWriter, releaseThreadWriter } from "./bridge-owner.js";

const assert = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve,ms));
async function check() {
  const dir = await mkdtemp(join(tmpdir(),"codex-relay-test-"));
  const path = join(dir,"state.json");
  const now = Math.floor(Date.now()/1000);
  let updated = now-120, turnId = "old-turn", calls = 0, resumeAllowed = true;
  const parent = {id:"parent",status:{type:"idle"},updatedAt:now-180};
  const child = () => ({id:"child",updatedAt:updated,status:{type:"idle"},source:{subAgent:{thread_spawn:{parent_thread_id:"parent"}}}});
  // Another sibling is still working; the finished child's result must
  // nevertheless reach the idle parent without waiting for it.
  const busySibling = {id:"busy-sibling",updatedAt:now-50,status:{type:"active"},source:{subAgent:{thread_spawn:{parent_thread_id:"parent"}}}};
  const historyless = {id:"historyless",updatedAt:now-400,status:{type:"notLoaded"},source:{subAgent:{thread_spawn:{parent_thread_id:"parent"}}}};
  const connect = async () => ({
    call: async (method: string, params: any) => {
      if (method === "thread/list") return {data:params.sourceKinds.includes("subAgent")?[child(),historyless,busySibling]:[parent],nextCursor:null};
      if (method === "thread/turns/list" && params.threadId === "historyless") return {data:[]};
      if (method === "thread/turns/list") return {data:[{id:turnId,status:"completed",items:params.itemsView === "full" ? [{type:"agentMessage",text:"Completed research."}] : []}]};
      if (method === "thread/resume") {if (!resumeAllowed) throw Error("active writer"); return {thread:{status:{type:"idle"}}};}
      if (method === "turn/start") {calls++; assert(params.input?.[0]?.text.includes("Completed research."),"child result missing"); return {turn:{id:"new-parent-turn",status:"completed"}};}
      throw Error(`Unexpected method ${method}`);
    },
    close: () => {},
    awaitTurnCompletion: async () => ({status:"completed"}),
  });
  const loop = new SubagentReturnLoop(path, connect as any);
  try {
    await loop.start();
    await sleep(100);
    assert(loop.status().initialized,"initial baseline missing");
    const checkpoint=JSON.parse(await readFile(path,"utf8"));
    assert(Object.keys(checkpoint.seen).length === 2,"historical child without turn was not baselined");
    assert(calls===0,"historical child wrongly replayed");
    resumeAllowed=false;
    updated += 30; turnId="new-turn";
    await (loop as any).tick();
    await sleep(100);
    assert(loop.status().pending===1 && calls===0,"locked parent should queue without sending");
    resumeAllowed=true;
    (loop as any).retryAt.clear(); // advance past the intentional lock-backoff in this synthetic test
    await (loop as any).tick();
    await sleep(100);
    assert(calls===1 && loop.status().delivered===1,"active sibling must not block completed child relay");
    await (loop as any).tick();
    await sleep(50);
    assert(calls===1,"duplicate delivery");
    let ownerCalls = 0;
    const owner = {
      call: async (method: string, params: any) => {
        assert(method === "turn/start", "Owner connection must not resume a thread");
        assert(params.threadId === "parent", "Wrong parent for owner relay");
        ownerCalls++;
        return {turn:{id:"browser-turn",status:"completed"}};
      },
      waitForTurn: async () => ({status:"completed"}),
    };
    claimThreadWriter("parent",owner);
    updated += 30; turnId="third-turn";
    await (loop as any).tick();
    await sleep(100);
    releaseThreadWriter(owner);
    assert(ownerCalls===1 && calls===1,"Existing WebUI writer was not reused");
    assert(loop.status().delivered===2,"WebUI writer relay not marked delivered");
    const saved=JSON.parse(await readFile(path,"utf8"));
    assert(saved.initialized && Object.values(saved.jobs).length===2,"persistent checkpoint invalid");
    console.log("SUBAGENT_RETURN_TESTS_PASS baseline/empty-history/queue/active-sibling-does-not-block/deliver/dedupe/persist/webui-owner-reuse");
  } finally { loop.stop(); await rm(dir,{recursive:true,force:true}); }
}
await check();
