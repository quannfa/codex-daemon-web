import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoalWaitManager } from "../server/goal-wait-manager";

const threadId = "00000000-0000-4000-8000-000000000001";
const nowStart = Date.parse("2026-11-16T12:00:00.000Z");

type FakeState = {
  now: number;
  latestTurnId: string;
  threadStatus: "idle" | "active" | "notLoaded";
  goal: { status: string; objective: string; updatedAt: number } | null;
  goalSetCalls: string[];
  queueAdds: Array<{ clientUserMessageId: string; input: unknown[] }>;
};

function fakeConnection(state: FakeState) {
  return {
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === "thread/goal/get") return { goal: state.goal };
      if (method === "thread/turns/list")
        return { data: state.latestTurnId ? [{ id: state.latestTurnId }] : [] };
      if (method === "thread/read")
        return { thread: { status: { type: state.threadStatus } } };
      if (method === "thread/goal/set") {
        const status = String(params.status);
        state.goalSetCalls.push(status);
        if (state.goal) {
          state.goal = { ...state.goal, status, updatedAt: state.goal.updatedAt + 1 };
        }
        return { goal: state.goal };
      }
      if (method === "thread/resume") {
        state.threadStatus = "idle";
        return { thread: { status: { type: "idle" } } };
      }
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      if (method === "thread/queue/add") {
        state.queueAdds.push({
          clientUserMessageId: String(params.clientUserMessageId),
          input: Array.isArray(params.input) ? params.input : [],
        });
        return { queuedSubmission: { id: "queued-1" } };
      }
      throw new Error(`Unexpected RPC method ${method}`);
    },
    close() {},
  };
}

test("active goals pause immediately and resume once at the deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-goal-wait-test-"));
  const state: FakeState = {
    now: nowStart,
    latestTurnId: "turn-1",
    threadStatus: "idle",
    goal: { status: "active", objective: "Finish the remote job", updatedAt: 10 },
    goalSetCalls: [],
    queueAdds: [],
  };
  const manager = new GoalWaitManager(
    join(directory, "waits.json"),
    async () => fakeConnection(state),
    () => state.now,
  );
  try {
    await manager.start();
    const until = new Date(nowStart + 1_000).toISOString();
    const registered = await manager.register(threadId, until, "remote job");
    assert.equal(registered.status, "scheduled");
    assert.deepEqual(state.goalSetCalls, ["paused"]);
    assert.equal(manager.pending().length, 1);
    assert.deepEqual(manager.waitStatus(threadId), {
      waitId: registered.waitId,
      threadId,
      until,
      reason: "remote job",
      resumeMode: "goal",
      phase: "waiting",
    });
    assert.deepEqual(manager.workingThreadIds(), [threadId]);

    const duplicate = await manager.register(threadId, until, "remote job");
    assert.equal(duplicate.status, "alreadyScheduled");

    state.now += 1_000;
    await (manager as any).process(registered.waitId);
    assert.deepEqual(state.goalSetCalls, ["paused", "active"]);
    assert.equal(manager.pending().length, 0);
    assert.equal(manager.waitStatus(threadId), null);

    await (manager as any).process(registered.waitId);
    assert.deepEqual(state.goalSetCalls, ["paused", "active"]);
    assert.equal(state.queueAdds.length, 0);
  } finally {
    manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a conversation without a goal receives one deduplicated continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-goal-wait-queue-test-"));
  const state: FakeState = {
    now: nowStart,
    latestTurnId: "turn-1",
    threadStatus: "idle",
    goal: null,
    goalSetCalls: [],
    queueAdds: [],
  };
  const manager = new GoalWaitManager(
    join(directory, "waits.json"),
    async () => fakeConnection(state),
    () => state.now,
  );
  try {
    await manager.start();
    const registered = await manager.register(
      threadId,
      new Date(nowStart + 1_000).toISOString(),
      "remote job",
    );
    assert.equal(registered.resumeMode, "queue");
    assert.deepEqual(manager.workingThreadIds(), []);
    state.now += 1_000;
    await (manager as any).process(registered.waitId);
    await (manager as any).process(registered.waitId);
    assert.equal(state.queueAdds.length, 1);
    const continuation = state.queueAdds[0].input[0] as { text?: string };
    assert.match(continuation.text ?? "", /wait completed/);
    assert.equal(manager.pending().length, 0);
  } finally {
    manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual activity restores an owned paused goal and cancels the wait", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-goal-wait-cancel-test-"));
  const state: FakeState = {
    now: nowStart,
    latestTurnId: "turn-1",
    threadStatus: "idle",
    goal: { status: "active", objective: "Continue", updatedAt: 20 },
    goalSetCalls: [],
    queueAdds: [],
  };
  const manager = new GoalWaitManager(
    join(directory, "waits.json"),
    async () => fakeConnection(state),
    () => state.now,
  );
  try {
    await manager.start();
    const registered = await manager.register(
      threadId,
      new Date(nowStart + 1_000).toISOString(),
      "remote job",
    );
    state.latestTurnId = "turn-manual";
    state.now += 1_000;
    await (manager as any).process(registered.waitId);
    assert.deepEqual(state.goalSetCalls, ["paused", "active"]);
    assert.equal(manager.pending().length, 0);
  } finally {
    manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
