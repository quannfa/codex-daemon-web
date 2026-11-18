import assert from "node:assert/strict";
import test from "node:test";
import { threadIndicator } from "../client/thread-status";
import type { ThreadSummary } from "../client/types";

const idleThread = {
  id: "thread-1",
  status: { type: "idle" },
} as ThreadSummary;

test("a registered wait uses the scheduled marker even while a turn is active", () => {
  assert.deepEqual(threadIndicator(idleThread,{goalWait:true}),{
    kind:"waiting",label:"Scheduled task · waiting to resume",
  });
  const activeThread = {...idleThread,status:{type:"active",activeFlags:[]}} as ThreadSummary;
  assert.equal(threadIndicator(activeThread,{goalWait:true}).kind,"waiting");
  assert.equal(threadIndicator(activeThread).kind,"working");
  assert.equal(threadIndicator(idleThread).kind,"idle");
  assert.equal(threadIndicator(idleThread,{goalWait:true,pendingDecision:true}).kind,"decision");
  assert.equal(threadIndicator({...idleThread,status:{type:"systemError"}},{goalWait:true}).kind,"error");
});
