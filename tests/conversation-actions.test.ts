import assert from "node:assert/strict";
import test from "node:test";
import {codexThreadLink,forkAtMessage,forkSettingsFromThread,isActiveAssistantTurn} from "../client/conversation-actions";

test("copies a Codex-native thread reference, not a WebUI browser URL",()=>{
  const id="01a1782f-e308-73a0-8f48-cc7382e27650";
  assert.equal(codexThreadLink(id),`codex://threads/${id}`);
  assert.throws(()=>codexThreadLink(""),/Invalid Codex thread ID/);
  assert.throws(()=>codexThreadLink("relative-path"),/Invalid Codex thread ID/);
  assert.throws(()=>codexThreadLink("01a1782f-e308-73a0-8f48-cc7382e27650?token=x"),/Invalid Codex thread ID/);
});
test("fork user messages before their turn and assistant messages through their turn",()=>{
  assert.deepEqual(forkAtMessage("parent","turn-1","userMessage"),
    {threadId:"parent",beforeTurnId:"turn-1",excludeTurns:true});
  assert.deepEqual(forkAtMessage("parent","turn-1","agentMessage"),
    {threadId:"parent",lastTurnId:"turn-1",excludeTurns:true});
  assert.deepEqual(forkAtMessage("parent","turn-1","agentMessage",{activeTurn:true}),
    {threadId:"parent",excludeTurns:true});
  assert.deepEqual(
    forkAtMessage("parent","turn-1","agentMessage",{
      settings:{model:"model-b",config:{model_reasoning_effort:"high"}},
    }),
    {
      threadId:"parent",
      lastTurnId:"turn-1",
      excludeTurns:true,
      model:"model-b",
      config:{model_reasoning_effort:"high"},
    },
  );
  assert.throws(()=>forkAtMessage("parent","","agentMessage"));
});
test("copies effective thread settings into fork overrides",()=>{
  assert.deepEqual(
    forkSettingsFromThread({
      model:"model-a",
      modelProvider:"openai",
      serviceTier:"default",
      cwd:"/workspace",
      runtimeWorkspaceRoots:["/workspace"],
      approvalPolicy:"on-request",
      approvalsReviewer:"user",
      sandbox:{type:"workspaceWrite",writableRoots:[],networkAccess:false},
      activePermissionProfile:{id:":workspace",extends:null},
      reasoningEffort:"high",
    }),
    {
      model:"model-a",
      modelProvider:"openai",
      serviceTier:"default",
      cwd:"/workspace",
      runtimeWorkspaceRoots:["/workspace"],
      approvalPolicy:"on-request",
      approvalsReviewer:"user",
      permissions:":workspace",
      config:{model_reasoning_effort:"high"},
    },
  );
  assert.deepEqual(
    forkSettingsFromThread({
      approvalPolicy:{granular:{sandbox_approval:true,rules:false,mcp_elicitations:true}},
      sandbox:{type:"readOnly",networkAccess:false},
      reasoningEffort:null,
    }),
    {
      approvalPolicy:{granular:{sandbox_approval:true,rules:false,skill_approval:false,request_permissions:false,mcp_elicitations:true}},
      sandbox:"read-only",
    },
  );
});
test("identifies the assistant item belonging to the active turn",()=>{
  assert.equal(isActiveAssistantTurn("active","agentMessage","active"),true);
  assert.equal(isActiveAssistantTurn("older","agentMessage","active"),false);
  assert.equal(isActiveAssistantTurn("active","userMessage","active"),false);
  assert.equal(isActiveAssistantTurn("unknown","agentMessage",null),false);
});
