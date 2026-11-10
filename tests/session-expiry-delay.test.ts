import assert from "node:assert/strict";
import test from "node:test";
import { MAX_NODE_TIMEOUT_MS, sessionExpiryDelay } from "../server/session-expiry-delay";

test("bounds a 180-day session expiry to Node's maximum timeout", () => {
  const now = 1_790_000_000_000;
  assert.equal(sessionExpiryDelay(now + 180 * 24 * 60 * 60 * 1000, now), MAX_NODE_TIMEOUT_MS);
});
test("uses the remaining duration when inside Node's supported range", () => {
  const now = 1_790_000_000_000;
  assert.equal(sessionExpiryDelay(now + 1000, now), 1001);
});
test("expires immediately once the session is no longer valid", () => {
  assert.equal(sessionExpiryDelay(50, 100), 1);
});
