import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWaitCountdown,
  goalWaitDisplayMode,
  isGoalWaitStatus,
  type GoalWaitStatus,
} from "../client/goal-wait";

const waiting: GoalWaitStatus = {
  waitId: "wait-1",
  threadId: "00000000-0000-4000-8000-000000000001",
  until: "2026-11-16T12:00:00.000Z",
  reason: "remote job",
  resumeMode: "goal",
  phase: "waiting",
};

test("formats countdowns without going negative and keeps long waits visible", () => {
  assert.equal(formatWaitCountdown(-1), "00:00:00");
  assert.equal(formatWaitCountdown(1), "00:00:01");
  assert.equal(formatWaitCountdown(3_661_000), "01:01:01");
  assert.equal(formatWaitCountdown(49 * 3_600_000), "49:00:00");
});

test("wait display follows the persisted phase and deadline", () => {
  assert.equal(goalWaitDisplayMode({...waiting,phase:"pausing"},Date.parse(waiting.until)-1),"preparing");
  assert.equal(goalWaitDisplayMode(waiting,Date.parse(waiting.until)-1),"waiting");
  assert.equal(goalWaitDisplayMode(waiting,Date.parse(waiting.until)),"resuming");
  assert.equal(goalWaitDisplayMode({...waiting,phase:"resuming"},Date.parse(waiting.until)-1),"resuming");
});

test("accepts only complete public wait summaries", () => {
  assert.equal(isGoalWaitStatus(waiting),true);
  assert.equal(isGoalWaitStatus({...waiting,until:"not-a-date"}),false);
  assert.equal(isGoalWaitStatus({...waiting,phase:"failed"}),false);
});
