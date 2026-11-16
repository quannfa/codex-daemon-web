const scheduledTurnWaitInstructions = [
  "[Scheduled run runtime rule]",
  "When work is still pending and you need to wait, keep this turn open and call the wait_until tool from the codex-scheduled-tasks MCP server with the full required duration or target timestamp.",
  "wait_until is mandatory for every model in this run, including models that expose a native clock. It keeps the current turn open until the daemon releases the wait.",
  "After wait_until returns, continue checking and acting in this same turn. Do not finish the turn just to make goal start another turn.",
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
