import assert from "node:assert/strict";
import test from "node:test";
import {conversationDeepLink,forkAtMessage} from "../client/conversation-actions";

test("links use the current webui mount and omit URL query credentials",()=>{
  assert.equal(conversationDeepLink("https://example.test","/codex/","thread-123"),
    "https://example.test/codex/#/thread/thread-123");
  assert.equal(conversationDeepLink("https://example.test","/","abc def"),
    "https://example.test/#/thread/abc%20def");
  assert.throws(()=>conversationDeepLink("https://example.test","/","bad\nthread"));
});
test("fork user messages before their turn and assistant messages through their turn",()=>{
  assert.deepEqual(forkAtMessage("parent","turn-1","userMessage"),
    {threadId:"parent",beforeTurnId:"turn-1",excludeTurns:true});
  assert.deepEqual(forkAtMessage("parent","turn-1","agentMessage"),
    {threadId:"parent",lastTurnId:"turn-1",excludeTurns:true});
  assert.throws(()=>forkAtMessage("parent","","agentMessage"));
});
