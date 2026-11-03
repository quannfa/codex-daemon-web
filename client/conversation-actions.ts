/** A shareable route contains no conversation content or credentials. */
export function conversationDeepLink(origin:string,pathname:string,threadId:string):string{
  if(!threadId||/[\u0000-\u001f\u007f]/.test(threadId))throw new Error("Invalid thread ID");
  const base=new URL(pathname||"/",origin);
  base.search="";
  base.hash="#/thread/"+encodeURIComponent(threadId);
  return base.href;
}

/** Codex app-server forks by turns, not arbitrary item IDs. */
export function forkAtMessage(threadId:string,turnId:string,kind:"userMessage"|"agentMessage"){
  if(!threadId||!turnId)throw new Error("This message has no saved Codex turn.");
  return kind==="userMessage"
    ? {threadId,beforeTurnId:turnId,excludeTurns:true}
    : {threadId,lastTurnId:turnId,excludeTurns:true};
}
