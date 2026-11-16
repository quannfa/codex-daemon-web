import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TURN_COMPLETION_TIMEOUT_MS,
  MAX_NODE_TIMEOUT_MS,
  parseTurnCompletionTimeout,
} from "../server/turn-completion-timeout";
import { buildScheduledTurnPrompt } from "../server/scheduled-turn-instructions";
import {
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  parseWaitRequest,
} from "../server/scheduled-task-control";

test("scheduled prompts defer the next turn during a wait", () => {
  const prompt = buildScheduledTurnPrompt("Check the remote job.");
  assert.match(prompt, /^Check the remote job\./);
  assert.match(prompt, /wait_until tool/);
  assert.match(prompt, /mandatory for every model/);
  assert.match(prompt, /deferred continuation/);
  assert.match(prompt, /end this turn/);
  assert.match(prompt, /Do not use clock\.sleep/);
});

test("empty scheduled prompts still receive runtime guidance", () => {
  assert.match(buildScheduledTurnPrompt("   "), /^\[Scheduled run runtime rule\]/);
});

test("long turn timeout defaults to 48 hours and accepts valid overrides", () => {
  assert.equal(parseTurnCompletionTimeout(undefined), DEFAULT_TURN_COMPLETION_TIMEOUT_MS);
  assert.equal(parseTurnCompletionTimeout("3600000"), 3_600_000);
  assert.equal(parseTurnCompletionTimeout(String(MAX_NODE_TIMEOUT_MS)), MAX_NODE_TIMEOUT_MS);
});

test("turn timeout rejects values that Node timers cannot represent", () => {
  for (const value of ["0", "-1", "1.5", String(MAX_NODE_TIMEOUT_MS + 1), "not-a-number"]) {
    assert.throws(() => parseTurnCompletionTimeout(value), /CODEX_WEB_TURN_COMPLETION_TIMEOUT_MS/);
  }
});

test("wait requests accept one bounded duration or future timestamp", () => {
  const now = Date.parse("2026-11-15T12:00:00.000Z");
  assert.deepEqual(parseWaitRequest({ durationMs: 1000, reason: "remote job" }, now), {
    durationMs: 1000,
    until: "2026-11-15T12:00:01.000Z",
    reason: "remote job",
  });
  assert.equal(
    parseWaitRequest({ until: "2026-11-15T12:00:01.000Z" }, now).durationMs,
    1000,
  );
  for (const request of [
    {},
    { durationMs: 1000, until: "2026-11-15T12:00:01.000Z" },
    { durationMs: MIN_WAIT_MS - 1 },
    { durationMs: MAX_WAIT_MS + 1 },
    { until: "2026-11-15T11:59:59.000Z" },
  ]) {
    assert.throws(() => parseWaitRequest(request, now));
  }
});

test("wait parsing remains bounded for the deferred scheduler", () => {
  const parsed = parseWaitRequest(
    { durationMs: MIN_WAIT_MS, reason: "deferred" },
    Date.parse("2026-11-15T12:00:00.000Z"),
  );
  assert.equal(parsed.durationMs, MIN_WAIT_MS);
});
