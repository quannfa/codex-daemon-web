import assert from "node:assert/strict";
import test from "node:test";
import {codexThreadLink,draftFromUserInputs,forkAtMessage,forkSettingsFromThread,isActiveAssistantTurn,revertAtMessage} from "../client/conversation-actions";

test("copies a Codex-native thread reference, not a WebUI browser URL",()=>{
  const id="01a1782f-e308-73a0-8f48-cc7382e27650";
  assert.equal(codexThreadLink(id),`codex://threads/${id}`);
  assert.throws(()=>codexThreadLink(""),/Invalid Codex thread ID/);
  assert.throws(()=>codexThreadLink("relative-path"),/Invalid Codex thread ID/);
  assert.throws(()=>codexThreadLink("01a1782f-e308-73a0-8f48-cc7382e27650?token=x"),/Invalid Codex thread ID/);
});
test("fork user messages before their turn and completed assistant messages through their turn",()=>{
  assert.deepEqual(forkAtMessage("parent","turn-1","userMessage"),
    {threadId:"parent",beforeTurnId:"turn-1",excludeTurns:true});
  assert.deepEqual(forkAtMessage("parent","turn-1","agentMessage"),
    {threadId:"parent",lastTurnId:"turn-1",excludeTurns:true});
  // An active turn cannot be named by lastTurnId; exclude it instead of
  // omitting the boundary and accidentally copying the whole parent.
  assert.deepEqual(forkAtMessage("parent","turn-1","agentMessage",{activeTurn:true}),
    {threadId:"parent",beforeTurnId:"turn-1",excludeTurns:true});
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
test("uses the official turn boundary when reverting a user message",()=>{
  assert.deepEqual(revertAtMessage("thread-1","turn-1"),{
    threadId:"thread-1",
    beforeTurnId:"turn-1",
  });
  assert.throws(()=>revertAtMessage("thread-1",""));
});
test("restores message text and reuses referenced attachments",()=>{
  const citation={
    type:"text" as const,
    text:':codex-file-citation{path="/tmp/session/image.png" purpose="input"}',
    text_elements:[],
  };
  assert.deepEqual(draftFromUserInputs([
    {type:"text",text:"Please inspect this",text_elements:[]},
    {type:"skill",name:"documents",path:"/skills/documents/SKILL.md"},
    citation,
    {type:"localImage",path:"/tmp/session/image.png",detail:"auto"},
    {type:"localAudio",path:"/tmp/session/note.wav"},
  ]),{
    text:"Please inspect this",
    selectedSkills:[{name:"documents",path:"/skills/documents/SKILL.md"}],
    attachments:[
      {
        name:"image.png",
        kind:"image",
        mime:"image/*",
        input:[citation,{type:"localImage",path:"/tmp/session/image.png",detail:"auto"}],
      },
      {
        name:"note.wav",
        kind:"file",
        mime:"audio/*",
        input:[{type:"localAudio",path:"/tmp/session/note.wav"}],
      },
    ],
  });
});
