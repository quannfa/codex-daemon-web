import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finalReply, ThreadUnreadStore, ThreadUnreadTracker } from "../server/thread-unread";

const since = 1_800_000_000_000;
const threadId = "fixture-thread";
const ref = (id: string) => ({ turnId: id, itemId: `reply-${id}` });
const turn = (id: string, completedAt: number, status = "completed", phase: string | null = "final_answer") => ({
  id, status, completedAt,
  items: [{ type: "agentMessage", id: `reply-${id}`, text: "A reply", phase }],
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "codex-thread-unread-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "unreads.json");
  let changes = 0;
  const store = new ThreadUnreadStore(path, () => { changes += 1; }, () => since);
  await store.initialize();
  return { path, store, revisionChanges: () => changes };
}

test("only completed turns with a final visible reply create unread", () => {
  const complete = turn("final", since);
  assert.deepEqual(finalReply({ ...complete, items: [...complete.items,
    ...turn("commentary", since, "completed", "commentary").items] }), ref("final"));
  assert.deepEqual(finalReply(turn("old-provider", since, "completed", null)), ref("old-provider"));
  assert.equal(finalReply(turn("working", since, "inProgress")), null);
  assert.equal(finalReply(turn("failed", since, "failed")), null);
  assert.equal(finalReply(turn("progress", since, "completed", "commentary")), null);
  assert.equal(finalReply({ ...complete, items: [{ type: "mcpToolCall", name: "wait_until" }] }), null);
});

test("acknowledging a snapshot preserves newer replies and newer manual marks", async t => {
  const { path, store, revisionChanges } = await fixture(t);
  const a = ref("a"), b = ref("b");
  await store.record(threadId, { id: "a", at: since }, [a]);
  await store.markUnread(threadId, a);
  const firstToken = store.details(threadId).manual?.token;
  await Promise.all([
    store.record(threadId, { id: "b", at: since + 1000 }, [b]),
    store.markUnread(threadId, b),
    store.acknowledge(threadId, [a], a, firstToken),
  ]);
  assert.deepEqual(store.details(threadId).replies, [b]);
  assert.notEqual(store.details(threadId).manual?.token, firstToken);
  const reopened = new ThreadUnreadStore(path, () => {}, () => since + 100_000);
  await reopened.initialize();
  assert.equal(reopened.since, since);
  assert.deepEqual(reopened.details(threadId), store.details(threadId));
  await reopened.acknowledge(threadId, [], null, reopened.details(threadId).manual?.token);
  assert.deepEqual(reopened.details(threadId), { replies: [b], manual: null });
  assert.equal(revisionChanges(), 5);
});

test("scans a history page at a time, catches up after restart, and prunes a rewind", async t => {
  const { path, store } = await fixture(t);
  const baseline = turn("old", since - 2000);
  const a = turn("a", since + 1000);
  const b = turn("b", since + 2000);
  const c = turn("c", since + 3000);
  let history = [baseline];
  const rpc = { async call<T>(method: string, params: Record<string, unknown> = {}) {
    assert.equal(method, "thread/turns/list");
    assert.equal(params.itemsView, "summary");
    const i = params.cursor === undefined ? 0 : Number(params.cursor);
    return { data: history.slice(i, i + 1), nextCursor: i + 1 < history.length ? String(i + 1) : null } as T;
  } };
  const scan = (tracker: ThreadUnreadTracker, updatedAt: number, type="idle") =>
    tracker.scan(rpc, [{ id: threadId, createdAt: since - 10_000, updatedAt, status: { type } }]);
  const tracker = new ThreadUnreadTracker(store);
  await scan(tracker, since);
  assert.deepEqual(store.snapshot().threads, {});

  history = [a, baseline];
  await scan(tracker, since + 1000);
  assert.deepEqual(store.details(threadId).replies, [ref("a")]);
  await store.acknowledge(threadId, [ref("a")], null);
  await scan(tracker, since + 1000, "active");
  assert.deepEqual(store.snapshot().threads, {});

  const reopened = new ThreadUnreadStore(path, () => {}, () => since + 600_000);
  await reopened.initialize();
  const afterRestart = new ThreadUnreadTracker(reopened);
  history = [c, b, a, baseline];
  await scan(afterRestart, since + 3000);
  assert.deepEqual(reopened.details(threadId).replies, [ref("b"), ref("c")]);

  history = [b, a, baseline];
  await scan(afterRestart, since + 4000);
  assert.deepEqual(reopened.details(threadId).replies, [ref("b")]);
});

test("a single read boundary clears a backlog without clearing a later reply", async t => {
  const { store } = await fixture(t);
  const backlog = Array.from({ length: 250 }, (_, i) => ref(`past-${i}`));
  const lastSeen = backlog.at(-1)!;
  const next = ref("next");
  await store.record(threadId, { id: next.turnId, at: since }, [...backlog, next]);
  await store.acknowledge(threadId, [], lastSeen);
  assert.deepEqual(store.details(threadId).replies, [next]);
});
