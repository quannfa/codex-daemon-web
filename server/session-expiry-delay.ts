/**
 * Node.js timers cannot represent delays greater than 2^31 - 1 ms.
 * A larger delay silently overflows to 1 ms, creating a timer storm.
 * Re-check the live session expiry after each bounded interval because
 * authenticated HTTP requests can renew a session.
 */
export const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

export function sessionExpiryDelay(expiryMs: number, nowMs: number): number {
  return Math.min(MAX_NODE_TIMEOUT_MS, Math.max(1, expiryMs - nowMs + 1));
}
