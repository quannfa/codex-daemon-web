import assert from "node:assert/strict";
import test from "node:test";
import { threadIndicator } from "../client/thread-status";
import type { ThreadSummary } from "../client/types";

const idleThread = {
  id: "thread-1",
  status: { type: "idle" },
} as ThreadSummary;

test("a goal wait is classified as working while preserving higher priority states", () => {
  assert.deepEqual(threadIndicator(idleThread,{goalWait:true}),{
    kind:"working",label:"Working · goal wait active",
  });
  assert.equal(threadIndicator(idleThread,{goalWait:true,pendingDecision:true}).kind,"decision");
  assert.equal(threadIndicator({...idleThread,status:{type:"systemError"}},{goalWait:true}).kind,"error");
});
