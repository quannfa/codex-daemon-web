import assert from "node:assert/strict";
import test from "node:test";
import {formatMessageTime,mergeItemTimestamps,messageTimestampMs,validTimestampMs} from "../client/message-time";

const start=Date.parse("2026-11-08T08:15:30.123Z");
const end=start+12500;

test("completed events and reconnects retain the original message start time",()=>{
 const started=mergeItemTimestamps({startedAtMs:start});
 const completed=mergeItemTimestamps({completedAtMs:end},started);
 assert.deepEqual(completed,{startedAtMs:start,completedAtMs:end});
 assert.equal(messageTimestampMs(completed),start);
 assert.deepEqual(mergeItemTimestamps({startedAtMs:null,completedAtMs:null},completed),completed);
 // History repairs a start timestamp missing from a completion-only live entry.
 assert.deepEqual(mergeItemTimestamps({completedAtMs:end},{startedAtMs:start}),completed);
 // A replayed start event must not discard the already known completion time.
 assert.deepEqual(mergeItemTimestamps({startedAtMs:start},completed),completed);
});

test("legacy messages use a recorded completion time or explicitly have no time",()=>{
 assert.equal(messageTimestampMs({completedAtMs:end}),end);
 for(const value of [undefined,null,0,-1,NaN,Infinity,8.64e15+1,"1794126940000"]){
  assert.equal(validTimestampMs(value),null);
  assert.equal(formatMessageTime({startedAtMs:value,completedAtMs:value}),null);
  assert.equal(messageTimestampMs({startedAtMs:value,completedAtMs:end}),end);
 }
 assert.equal(messageTimestampMs({}),null);
});

test("formatting uses the viewer's timezone and a stable machine-readable instant",()=>{
 const original=process.env.TZ;
 try{
  process.env.TZ="UTC";
  const utc=formatMessageTime({startedAtMs:start})!;
  assert.equal(utc.label,"2026-11-08 08:15:30");
  assert.equal(utc.dateTime,"2026-11-08T08:15:30.123Z");
  process.env.TZ="Asia/Shanghai";
  const local=formatMessageTime({startedAtMs:start,completedAtMs:end})!;
  assert.equal(local.label,"2026-11-08 16:15:30");
  assert.equal(local.dateTime,utc.dateTime);
  assert.ok(local.title.length>0);
  process.env.TZ="America/Los_Angeles";
  assert.equal(formatMessageTime({startedAtMs:start})!.label,"2026-11-08 00:15:30");
 }finally{
  if(original===undefined)delete process.env.TZ;
  else process.env.TZ=original;
 }
});
