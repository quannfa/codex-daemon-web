export const DEFAULT_TURN_COMPLETION_TIMEOUT_MS = 48 * 60 * 60 * 1000;
export const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

export function parseTurnCompletionTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "")
    return DEFAULT_TURN_COMPLETION_TIMEOUT_MS;
  const milliseconds = Number(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > MAX_NODE_TIMEOUT_MS
  ) {
    throw new Error(
      "CODEX_WEB_TURN_COMPLETION_TIMEOUT_MS must be an integer from 1 to 2147483647",
    );
  }
  return milliseconds;
}
