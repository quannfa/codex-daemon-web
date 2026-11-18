import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { AppServerRpc } from "./app-server-rpc.js";
import { daemonThreadId } from "./scheduled-task-target.js";

export type ReplyRef = { turnId: string; itemId: string };
type ManualUnread = { token: string; reply: ReplyRef | null };
type Unread = { replies: ReplyRef[]; manual: ManualUnread | null };
type Head = { id: string; at: number };
type Entry = Unread & { head: Head | null };
type State = { version: 1; since: number; threads: Record<string, Entry> };
type Turn = { id: string; status: string; completedAt?: number | null; startedAt?: number | null; items: unknown[] };
type TurnPage = { data: Turn[]; nextCursor: string | null };
type ListedThread = { id: string; updatedAt: number; createdAt?: number; status?: { type: string } };
type Reader = Pick<AppServerRpc, "call">;
const threadSources = ["cli", "vscode", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"];
const sweepInterval = 15_000;

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
export const isReplyRef = (value: unknown): value is ReplyRef => {
  const ref = asObject(value);
  return validId(ref?.turnId) && validId(ref?.itemId);
};
const sameReply = (a: ReplyRef, b: ReplyRef) => a.turnId === b.turnId && a.itemId === b.itemId;
const timeMs = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value < 1e12 ? Math.floor(value * 1000) : value : 0;
const turnTime = (turn: Turn) => timeMs(turn.completedAt) || timeMs(turn.startedAt) ||
  (/^[\da-f]{8}-[\da-f]{4}-7/i.test(turn.id) ? parseInt(turn.id.slice(0, 13).replace("-", ""), 16) : 0);

export function finalReply(turn: Turn): ReplyRef | null {
  if (turn.status !== "completed") return null;
  let legacy: ReplyRef | null = null;
  for (const value of [...turn.items].reverse()) {
    const item = asObject(value);
    if (item?.type !== "agentMessage" || !validId(item.id) ||
        typeof item.text !== "string" || !item.text.trim()) continue;
    const ref = { turnId: turn.id, itemId: item.id };
    if (item.phase === "final_answer") return ref;
    // Older providers omit the phase. Use their last visible reply only after completion.
    if (item.phase == null && legacy === null) legacy = ref;
  }
  return legacy;
}

const empty = (): Entry => ({ head: null, replies: [], manual: null });
const hasUnread = (entry: Unread) => entry.replies.length > 0 || entry.manual !== null;
const warn = (error: unknown) => process.stderr.write(
  `[thread-unread] ${error instanceof Error ? error.message : String(error)}\n`,
);

export class ThreadUnreadStore {
  private state: State;
  private sequence = Promise.resolve();
  private revision = 0;

  constructor(private readonly path: string, private readonly changed: () => void,
    now: () => number = Date.now) {
    this.state = { version: 1, since: Math.ceil(now() / 1000) * 1000, threads: {} };
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await readFile(this.path, "utf8")) as State;
      if (stored.version !== 1 || !Number.isSafeInteger(stored.since) ||
          !asObject(stored.threads)) throw new Error("Invalid unread state");
      this.state = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save(this.state);
    }
  }

  get since(): number { return this.state.since; }
  head(threadId: string): Head | null { return this.state.threads[threadId]?.head ?? null; }
  details(threadId: string): Unread {
    const { replies, manual } = this.state.threads[threadId] ?? empty();
    return { replies, manual };
  }
  snapshot() {
    return { revision: this.revision, threads: Object.fromEntries(
      Object.entries(this.state.threads).filter(([, entry]) => hasUnread(entry))
        .map(([id, { replies, manual }]) => [id, { replies, manual }]),
    ) };
  }

  record(threadId: string, head: Head | null, newReplies: ReplyRef[], retained?: ReadonlySet<string>) {
    return this.change(threadId, (entry) => {
      const replies = retained ? entry.replies.filter(reply => retained.has(reply.turnId)) : [...entry.replies];
      for (const reply of newReplies)
        if (!replies.some(prior => sameReply(prior, reply))) replies.push(reply);
      const manual = entry.manual?.reply && retained && !retained.has(entry.manual.reply.turnId)
        ? { ...entry.manual, reply: null } : entry.manual;
      return { head, replies, manual };
    });
  }

  acknowledge(threadId: string, seen: ReplyRef[], through: ReplyRef | null, manualToken?: string) {
    return this.change(threadId, (entry) => {
      const boundary = through ? entry.replies.findIndex(reply => sameReply(reply, through)) : -1;
      return { ...entry,
        replies: entry.replies.filter((reply, index) => index > boundary &&
          !seen.some(observed => sameReply(reply, observed))),
        manual: entry.manual && entry.manual.token === manualToken ? null : entry.manual,
      };
    });
  }

  markUnread(threadId: string, reply: ReplyRef | null) {
    return this.change(threadId, (entry) => ({ ...entry, manual: { token: randomUUID(), reply } }));
  }

  private change(threadId: string, update: (entry: Entry) => Entry): Promise<void> {
    const operation = this.sequence.then(async () => {
      const previous = this.state.threads[threadId] ?? empty();
      const next = update(previous);
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      const state = { ...this.state, threads: { ...this.state.threads, [threadId]: next } };
      await this.save(state);
      this.state = state;
      if (JSON.stringify([previous.replies, previous.manual]) !== JSON.stringify([next.replies, next.manual])) {
        this.revision += 1;
        this.changed();
      }
    });
    this.sequence = operation.catch(() => {});
    return operation;
  }

  private async save(state: State): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

export class ThreadUnreadTracker {
  private readonly scans = new Map<string, Promise<void>>();
  private readonly observed = new Map<string, string>();
  private readonly requested = new Set<string>();
  private timer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;
  private lastSweep = 0;
  private stopped = false;
  private draining = false;

  constructor(private readonly store: ThreadUnreadStore) {}

  start() {
    if (this.sweepTimer || this.stopped) return;
    this.sweepTimer = setInterval(() => void this.sweep(), sweepInterval);
    this.sweepTimer.unref();
    void this.sweep();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.sweepTimer);
  }

  notify(threadIdValue: string) {
    if (this.stopped) return;
    let threadId: string;
    try { threadId = daemonThreadId(threadIdValue); } catch { return; }
    this.requested.add(threadId);
    this.schedule();
  }

  private schedule() {
    if (this.timer || this.draining || this.stopped || !this.requested.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, 120);
    this.timer.unref();
  }

  private async drain() {
    if (this.stopped) return;
    const ids = [...this.requested];
    this.requested.clear();
    this.draining = true;
    let rpc: AppServerRpc | undefined;
    try {
      rpc = await AppServerRpc.connect();
      for (const id of ids) {
        try { await this.refresh(rpc, id); } catch (error) { warn(error); }
      }
    } catch (error) { warn(error); }
    finally {
      rpc?.close();
      this.draining = false;
      this.schedule();
    }
  }

  private async sweep() {
    if (this.sweeping || this.stopped) return;
    this.sweeping = true;
    const started = Date.now();
    let rpc: AppServerRpc | undefined;
    try {
      rpc = await AppServerRpc.connect();
      const since = Math.max(this.store.since - 1000, this.lastSweep - 2 * sweepInterval);
      // Keep scanning threads we saw active even if their metadata predates the
      // current window. Some reply providers don't advance updatedAt until idle.
      const active = new Set<string>();
      for (const archived of [false, true]) {
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
          const page: { data: ListedThread[]; nextCursor: string | null } = await rpc.call("thread/list", {
            limit: 100, sourceKinds: threadSources, sortKey: "updated_at", sortDirection: "desc",
            archived, ...(cursor ? { cursor } : {}),
          });
          for (const thread of page.data)
            if (thread.status?.type === "active") active.add(thread.id);
          await this.scan(rpc, page.data.filter(thread => timeMs(thread.updatedAt) >= since ||
            thread.status?.type === "active" || this.active.has(thread.id)));
          if (this.stopped || page.data.some(thread => timeMs(thread.updatedAt) < since)) break;
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error("The daemon repeated a conversation history cursor");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      await this.scan(rpc, [...this.active].filter(id => !active.has(id)).map(id => ({ id, updatedAt: started })));
      this.active = active;
      this.lastSweep = started;
    } catch (error) { warn(error); }
    finally { rpc?.close(); this.sweeping = false; }
  }

  private active = new Set<string>();

  async scan(rpc: Reader, threads: ListedThread[]) {
    for (const thread of threads) {
      if (this.stopped) break;
      if (timeMs(thread.updatedAt) + 1000 < this.store.since &&
          thread.status?.type !== "active" && !this.store.head(thread.id)) continue;
      const signature = `${thread.updatedAt}:${thread.status?.type ?? ""}`;
      if (this.observed.get(thread.id) === signature && thread.status?.type !== "active" &&
          timeMs(thread.updatedAt) < Date.now() - 2 * sweepInterval) continue;
      try {
        await this.refresh(rpc, thread.id, timeMs(thread.createdAt));
        this.observed.set(thread.id, signature);
      } catch (error) { warn(error); }
    }
  }

  async latestReply(threadId: string): Promise<ReplyRef | null> {
    const rpc = await AppServerRpc.connect();
    try {
      let cursor: string | null = null;
      do {
        const page = await this.turns(rpc, threadId, cursor);
        for (const turn of page.data) {
          const reply = finalReply(turn);
          if (reply) return reply;
        }
        cursor = page.nextCursor === cursor ? null : page.nextCursor;
      } while (cursor);
      return null;
    } finally { rpc.close(); }
  }

  private turns(rpc: Reader, threadId: string, cursor: string | null) {
    return rpc.call<TurnPage>("thread/turns/list", {
      threadId, sortDirection: "desc", itemsView: "summary", limit: 25,
      ...(cursor ? { cursor } : {}),
    });
  }

  private refresh(rpc: Reader, threadId: string, createdAt = 0) {
    const pending = this.scans.get(threadId) ?? Promise.resolve();
    const scan = pending.catch(() => {}).then(() => this.reconcile(rpc, threadId, createdAt));
    this.scans.set(threadId, scan);
    return scan.finally(() => {
      if (this.scans.get(threadId) === scan) this.scans.delete(threadId);
    });
  }

  private async reconcile(rpc: Reader, threadId: string, createdAt: number) {
    const previous = this.store.head(threadId);
    if (!previous && !createdAt) {
      const result = await rpc.call<{ thread: { createdAt: number } }>("thread/read", { threadId, includeTurns: false });
      createdAt = timeMs(result.thread.createdAt);
    }
    const since = Math.max(this.store.since, createdAt);
    const turns: Turn[] = [];
    let foundHead = false;
    let head: Head | null = null;
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const page = await this.turns(rpc, threadId, cursor);
      let beforeBaseline = false;
      for (const turn of page.data) {
        if (turn.status === "inProgress") continue;
        const at = turnTime(turn);
        head ??= { id: turn.id, at };
        if (turn.id === previous?.id) { foundHead = true; break; }
        turns.push(turn);
        if (at && at < since) { beforeBaseline = true; break; }
      }
      if (foundHead || beforeBaseline) break;
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("The daemon repeated a turn history cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);

    if (foundHead && !turns.length) return;
    // A rewind can remove the previous head. Keep surviving unread entries and
    // don't replay the old history between the new head and our original baseline.
    const retained = previous && !foundHead ? new Set(turns.map(turn => turn.id)) : undefined;
    const replies = turns.reverse().flatMap(turn => {
      const at = turnTime(turn);
      if ((!previous || !foundHead) && (at < since || (previous && at <= previous.at))) return [];
      const reply = finalReply(turn);
      return reply ? [reply] : [];
    });
    if (!previous && !replies.length && head && head.at < since) return;
    // Keep the previous timestamp floor after a rewind so a later scan cannot
    // rediscover an earlier, already read reply as new.
    if (head && previous && !foundHead) head.at = Math.max(head.at, previous.at);
    await this.store.record(threadId, head, replies, retained);
  }
}
