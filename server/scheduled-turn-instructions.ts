const scheduledTurnWaitInstructions = [
  "[Scheduled run runtime rule]",
  "When work is still pending and you need to wait, call the wait_until tool from the codex-scheduled-tasks MCP server with the full required duration or target timestamp.",
  "wait_until is mandatory for every model in this run, including models that expose a native clock. It registers a WebUI-managed deferred continuation and returns immediately.",
  "After wait_until returns, end this turn. Do not check the remote state, retry the wait, or perform more work in this turn; WebUI will resume one continuation turn at the requested time.",
  "Do not use clock.sleep, shell sleep, exec or write_stdin polling, background sleep processes, functions.wait, or short repeated checks as a substitute for wait_until.",
  "If a remote command must keep running, start or confirm it first, then call wait_until and inspect it after waking.",
].join("\n");

export function buildScheduledTurnPrompt(prompt: string): string {
  const normalized = prompt.trim();
  return normalized
    ? `${normalized}\n\n${scheduledTurnWaitInstructions}`
    : scheduledTurnWaitInstructions;
}

export { scheduledTurnWaitInstructions };
