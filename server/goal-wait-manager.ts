import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { AppServerRpc } from "./app-server-rpc.js";
import { daemonThreadId } from "./scheduled-task-target.js";
import { TaskValidationError } from "./scheduled-tasks.js";

type JsonRecord = Record<string, unknown>;
type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

type RpcConnection = {
  call<T = JsonRecord>(
    method: string,
    params?: JsonRecord,
  ): Promise<T>;
  close(): void;
};

type GoalSnapshot = {
  status: GoalStatus;
  objective: string;
  updatedAt: number | null;
};

type StoredWait = {
  id: string;
  threadId: string;
  until: string;
  reason: string;
  createdAt: number;
  sourceTurnId: string | null;
  resumeMode: "goal" | "queue";
  initialGoalUpdatedAt: number | null;
  pausedGoalUpdatedAt: number | null;
  clientUserMessageId: string;
  phase: "pausing" | "waiting" | "resuming";
  retryAt: number | null;
  attempts: number;
  lastError: string | null;
};

type StoreData = { version: 1; waits: StoredWait[] };

type ThreadSnapshot = {
  status: string;
  latestTurnId: string | null;
  goal: GoalSnapshot | null;
};

export type GoalWaitResult = {
  status: "scheduled" | "alreadyScheduled" | "pending";
  waitId: string;
  threadId: string;
  until: string;
  resumeMode: "goal" | "queue";
  message: string;
  reason?: string;
};

export type GoalWaitStatus = {
  waitId: string;
  threadId: string;
  until: string;
  reason: string;
  resumeMode: "goal" | "queue";
  phase: "pausing" | "waiting" | "resuming";
};

const retryDelayMs = 5_000;
const goalVerificationDelayMs = 5_000;
const maxTimerDelayMs = 2_000_000_000;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function goalSnapshot(value: unknown): GoalSnapshot | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (
    status !== "active" &&
    status !== "paused" &&
    status !== "blocked" &&
    status !== "usageLimited" &&
    status !== "budgetLimited" &&
    status !== "complete"
  )
    return null;
  return {
    status,
    objective: stringValue(value.objective) ?? "",
    updatedAt: numberValue(value.updatedAt),
  };
}

function goalFromResponse(value: unknown): GoalSnapshot | null {
  return isRecord(value) ? goalSnapshot(value.goal) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function stableClientMessageId(waitId: string): string {
  const hash = createHash("sha256")
    .update(`codex-web-goal-wait-v1:${waitId}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const value = hash.subarray(0, 16).toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function continuationMessage(wait: StoredWait): string {
  const reason = wait.reason ? `\nReason: ${wait.reason}` : "";
  return [
    "[Codex WebUI wait completed]",
    `The requested wait ended at ${wait.until}.${reason}`,
    "Continue the original task now. Check the waiting condition before taking the next action.",
  ].join("\n");
}

async function prepareStateDirectory(filePath: string): Promise<string> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory())
    throw new Error("Goal wait state directory must be a real directory");
  if (typeof process.getuid === "function" && details.uid !== process.getuid())
    throw new Error("Goal wait state directory must be owned by the current user");
  if ((details.mode & 0o077) !== 0) await chmod(directory, 0o700);
  return directory;
}

function parseState(value: unknown): StoreData {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.waits))
    throw new Error("Goal wait state has an unsupported format");
  const waits = value.waits.map((entry) => {
    if (!isRecord(entry)) throw new Error("Goal wait state contains an invalid wait");
    const phase = entry.phase;
    const resumeMode = entry.resumeMode;
    if (
      typeof entry.id !== "string" ||
      typeof entry.threadId !== "string" ||
      typeof entry.until !== "string" ||
      typeof entry.reason !== "string" ||
      (phase !== "pausing" && phase !== "waiting" && phase !== "resuming") ||
      (resumeMode !== "goal" && resumeMode !== "queue")
    )
      throw new Error("Goal wait state contains an invalid wait");
    return {
      id: entry.id,
      threadId: entry.threadId,
      until: entry.until,
      reason: entry.reason,
      createdAt: numberValue(entry.createdAt) ?? Date.now(),
      sourceTurnId: stringValue(entry.sourceTurnId),
      resumeMode,
      initialGoalUpdatedAt: numberValue(entry.initialGoalUpdatedAt),
      pausedGoalUpdatedAt: numberValue(entry.pausedGoalUpdatedAt),
      clientUserMessageId:
        stringValue(entry.clientUserMessageId) ?? stableClientMessageId(entry.id),
      phase,
      retryAt: numberValue(entry.retryAt),
      attempts: numberValue(entry.attempts) ?? 0,
      lastError: stringValue(entry.lastError),
    } satisfies StoredWait;
  });
  return { version: 1, waits };
}

export class GoalWaitManager {
  private data: StoreData = { version: 1, waits: [] };
  private initialized: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = true;

  constructor(
    private readonly filePath: string,
    private readonly connect: () => Promise<RpcConnection> = () => AppServerRpc.connect(),
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    await this.initialize();
    this.stopped = false;
    let changed = false;
    for (const wait of this.data.waits) {
      if (wait.phase === "resuming") {
        wait.phase = "waiting";
        wait.retryAt = null;
        changed = true;
      }
    }
    if (changed) await this.save();
    for (const wait of this.data.waits) this.schedule(wait);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  pending(threadId?: string): StoredWait[] {
    return this.data.waits
      .filter((wait) => !threadId || wait.threadId === threadId)
      .map((wait) => structuredClone(wait));
  }

  waitStatus(threadIdValue: unknown): GoalWaitStatus | null {
    const threadId = daemonThreadId(threadIdValue);
    const wait = this.data.waits.find((entry) => entry.threadId === threadId);
    if (!wait) return null;
    return {
      waitId: wait.id,
      threadId: wait.threadId,
      until: wait.until,
      reason: wait.reason,
      resumeMode: wait.resumeMode,
      phase: wait.phase,
    };
  }

  workingThreadIds(): string[] {
    return this.data.waits
      .filter((wait) => wait.resumeMode === "goal")
      .map((wait) => wait.threadId);
  }

  async cancel(threadIdValue: string): Promise<boolean> {
    const threadId = daemonThreadId(threadIdValue);
    await this.initialize();
    return this.exclusive(async () => {
      const wait = this.data.waits.find((entry) => entry.threadId === threadId);
      if (!wait) return false;
      this.remove(wait.id);
      await this.save();
      return true;
    });
  }

  async register(
    threadIdValue: string,
    until: string,
    reason: string,
  ): Promise<GoalWaitResult> {
    const threadId = daemonThreadId(threadIdValue);
    const timestamp = Date.parse(until);
    if (!Number.isFinite(timestamp) || timestamp <= this.now())
      throw new TaskValidationError("Wait timestamp must be in the future");
    await this.initialize();
    return this.exclusive(async () => {
      const existing = this.data.waits.find((wait) => wait.threadId === threadId);
      if (existing) {
        let rpc: RpcConnection | undefined;
        try {
          rpc = await this.connect();
          const goalResponse = await rpc.call<{ goal?: unknown }>(
            "thread/goal/get",
            { threadId },
          );
          if (
            existing.resumeMode !== "goal" ||
            this.ownsPausedGoal(existing, goalSnapshot(goalResponse.goal))
          )
            return this.result(existing, "alreadyScheduled");
          this.remove(existing.id);
          await this.save();
        } finally {
          rpc?.close();
        }
      }

      let rpc: RpcConnection | undefined;
      let wait: StoredWait | undefined;
      try {
        rpc = await this.connect();
        const goalResponse = await rpc.call<{ goal?: unknown }>(
          "thread/goal/get",
          { threadId },
        );
        const goal = goalSnapshot(goalResponse.goal);
        if (goal && goal.status !== "active")
          throw new TaskValidationError(
            `The conversation goal is ${goal.status}; resume it before registering a wait`,
          );
        const sourceTurnId = await this.latestTurnId(rpc, threadId);
        wait = {
          id: randomUUID(),
          threadId,
          until: new Date(timestamp).toISOString(),
          reason,
          createdAt: this.now(),
          sourceTurnId,
          resumeMode: goal?.status === "active" ? "goal" : "queue",
          initialGoalUpdatedAt: goal?.updatedAt ?? null,
          pausedGoalUpdatedAt: null,
          clientUserMessageId: "",
          phase: goal?.status === "active" ? "pausing" : "waiting",
          retryAt: null,
          attempts: 0,
          lastError: null,
        };
        wait.clientUserMessageId = stableClientMessageId(wait.id);
        this.data.waits.push(wait);
        await this.save();

        if (wait.resumeMode === "goal") {
          try {
            await this.pauseGoal(rpc, wait);
            wait.phase = "waiting";
            await this.save();
          } catch (error) {
            wait.retryAt = this.now() + retryDelayMs;
            wait.lastError = errorText(error);
            await this.save();
            this.schedule(wait);
            return this.result(wait, "pending");
          }
        }
        this.schedule(wait);
        return this.result(wait, "scheduled");
      } finally {
        rpc?.close();
      }
    });
  }

  private result(wait: StoredWait, status: GoalWaitResult["status"]): GoalWaitResult {
    return {
      status,
      waitId: wait.id,
      threadId: wait.threadId,
      until: wait.until,
      resumeMode: wait.resumeMode,
      message:
        status === "pending"
          ? "The wait is recorded. WebUI is still pausing the automatic continuation; end this turn and do not retry the wait tool."
          : status === "alreadyScheduled"
            ? "This conversation already has a pending wait. End this turn and do not create another wait."
            : "The wait is registered. End this turn now; WebUI will resume one continuation turn at the requested time.",
      ...(wait.reason ? { reason: wait.reason } : {}),
    };
  }

  private async initialize(): Promise<void> {
    this.initialized ??= this.load();
    await this.initialized;
  }

  private async load(): Promise<void> {
    await prepareStateDirectory(this.filePath);
    try {
      const details = await lstat(this.filePath);
      if (!details.isFile()) throw new Error("Goal wait state path must be a file");
      if (typeof process.getuid === "function" && details.uid !== process.getuid())
        throw new Error("Goal wait state file must be owned by the current user");
      if ((details.mode & 0o077) !== 0) await chmod(this.filePath, 0o600);
      const fileDetails = await stat(this.filePath);
      if (fileDetails.size > 10 * 1024 * 1024)
        throw new Error("Goal wait state exceeds 10 MB");
      this.data = parseState(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save();
    }
  }

  private async save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const write = async () => {
      const directory = await prepareStateDirectory(this.filePath);
      const temporaryPath = `${directory}/.goal-waits-${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
      try {
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          await file.writeFile(`${snapshot}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    };
    this.writeQueue = this.writeQueue.then(write, write);
    await this.writeQueue;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private schedule(wait: StoredWait): void {
    if (this.stopped) return;
    const prior = this.timers.get(wait.id);
    if (prior) clearTimeout(prior);
    const until = Date.parse(wait.until);
    const retryAt = wait.retryAt ?? 0;
    const now = this.now();
    const target =
      wait.resumeMode === "goal" && wait.phase === "waiting" && now < until
        ? Math.min(until, Math.max(now + goalVerificationDelayMs, retryAt))
        : wait.phase === "pausing"
          ? Math.max(now, retryAt)
          : Math.max(until, retryAt);
    const delay = Math.max(0, target - now);
    const timer = setTimeout(() => {
      this.timers.delete(wait.id);
      void this.process(wait.id).catch((error) => {
        process.stderr.write(`[goal-wait] processing failed: ${errorText(error)}\n`);
      });
    }, Math.min(delay, maxTimerDelayMs));
    timer.unref();
    this.timers.set(wait.id, timer);
  }

  private async process(waitId: string): Promise<void> {
    if (this.stopped) return;
    await this.initialize();
    await this.exclusive(async () => {
      const wait = this.data.waits.find((entry) => entry.id === waitId);
      if (!wait) return;
      const until = Date.parse(wait.until);
      const retryAt = wait.retryAt ?? 0;
      if (this.now() < retryAt) {
        this.schedule(wait);
        return;
      }

      if (
        wait.resumeMode !== "goal" &&
        wait.phase !== "pausing" &&
        this.now() < until
      ) {
        this.schedule(wait);
        return;
      }

      let rpc: RpcConnection | undefined;
      try {
        rpc = await this.connect();
        if (
          wait.resumeMode === "goal" &&
          wait.phase === "waiting" &&
          this.now() < until
        ) {
          const goalResponse = await rpc.call<{ goal?: unknown }>(
            "thread/goal/get",
            { threadId: wait.threadId },
          );
          if (!this.ownsPausedGoal(wait, goalSnapshot(goalResponse.goal))) {
            this.remove(wait.id);
            await this.save();
            return;
          }
          this.schedule(wait);
          return;
        }
        if (wait.phase === "pausing") {
          await this.pauseGoal(rpc, wait);
          wait.phase = "waiting";
          wait.retryAt = null;
          wait.lastError = null;
          await this.save();
          this.schedule(wait);
          return;
        }

        wait.phase = "resuming";
        wait.attempts += 1;
        wait.retryAt = null;
        await this.save();
        if (wait.resumeMode === "goal") await this.resumeGoal(rpc, wait);
        else await this.resumeQueue(rpc, wait);
        this.remove(wait.id);
        await this.save();
      } catch (error) {
        wait.phase = "waiting";
        wait.retryAt = this.now() + retryDelayMs;
        wait.lastError = errorText(error);
        await this.save();
        this.schedule(wait);
      } finally {
        rpc?.close();
      }
    });
  }

  private async pauseGoal(rpc: RpcConnection, wait: StoredWait): Promise<void> {
    const current = await this.readThread(rpc, wait.threadId);
    if (!current.goal || current.goal.status !== "active") {
      if (
        current.goal?.status === "paused" &&
        wait.initialGoalUpdatedAt !== null &&
        current.goal.updatedAt === wait.initialGoalUpdatedAt
      ) {
        wait.pausedGoalUpdatedAt = current.goal.updatedAt;
        return;
      }
      throw new Error("The conversation goal changed before the wait was registered");
    }
    const response = await rpc.call<{ goal?: unknown }>("thread/goal/set", {
      threadId: wait.threadId,
      status: "paused",
      origin: "user",
    });
    let paused = goalFromResponse(response);
    if (!paused) {
      const refreshed = await rpc.call<{ goal?: unknown }>("thread/goal/get", {
        threadId: wait.threadId,
      });
      paused = goalFromResponse(refreshed);
    }
    if (!paused || paused.status !== "paused")
      throw new Error("Codex did not confirm that the goal was paused");
    wait.pausedGoalUpdatedAt = paused.updatedAt;
  }

  private async resumeGoal(rpc: RpcConnection, wait: StoredWait): Promise<void> {
    const current = await this.readThread(rpc, wait.threadId);
    if (current.latestTurnId && wait.sourceTurnId && current.latestTurnId !== wait.sourceTurnId) {
      if (this.ownsPausedGoal(wait, current.goal)) {
        await this.setGoalStatus(rpc, wait.threadId, "active");
      }
      return;
    }
    if (!current.goal) return;
    if (current.goal.status === "active") return;
    if (current.goal.status !== "paused" || !this.ownsPausedGoal(wait, current.goal)) return;
    if (current.status === "active") throw new Error("The waiting conversation is still running");
    if (current.status === "notLoaded")
      await rpc.call("thread/resume", { threadId: wait.threadId, excludeTurns: true });
    await this.setGoalStatus(rpc, wait.threadId, "active");
  }

  private async setGoalStatus(
    rpc: RpcConnection,
    threadId: string,
    status: "active" | "paused",
  ): Promise<void> {
    const response = await rpc.call<{ goal?: unknown }>("thread/goal/set", {
      threadId,
      status,
      origin: "automatic",
    });
    const goal = goalFromResponse(response);
    if (goal && goal.status !== status)
      throw new Error(`Codex did not confirm goal status ${status}`);
  }

  private async resumeQueue(rpc: RpcConnection, wait: StoredWait): Promise<void> {
    const current = await this.readThread(rpc, wait.threadId);
    if (current.latestTurnId && wait.sourceTurnId && current.latestTurnId !== wait.sourceTurnId)
      return;
    if (current.status === "active") throw new Error("The waiting conversation is still running");
    if (current.status === "notLoaded")
      await rpc.call("thread/resume", { threadId: wait.threadId, excludeTurns: true });
    const submission = await this.submissionState(rpc, wait);
    if (submission === "found") return;
    if (submission === "unknown") throw new Error("Could not verify a prior wait continuation");
    await rpc.call("thread/queue/add", {
      threadId: wait.threadId,
      clientUserMessageId: wait.clientUserMessageId,
      input: [{ type: "text", text: continuationMessage(wait), text_elements: [] }],
    });
  }

  private ownsPausedGoal(wait: StoredWait, goal: GoalSnapshot | null): boolean {
    if (!goal || goal.status !== "paused") return false;
    return wait.pausedGoalUpdatedAt === null || goal.updatedAt === wait.pausedGoalUpdatedAt;
  }

  private async readThread(rpc: RpcConnection, threadId: string): Promise<ThreadSnapshot> {
    const [threadResponse, latestTurnId, goalResponse] = await Promise.all([
      rpc.call<{ thread?: unknown }>("thread/read", {
        threadId,
        includeTurns: false,
      }),
      this.latestTurnId(rpc, threadId),
      rpc.call<{ goal?: unknown }>("thread/goal/get", { threadId }),
    ]);
    const thread = isRecord(threadResponse.thread) ? threadResponse.thread : {};
    const status = isRecord(thread.status) && typeof thread.status.type === "string"
      ? thread.status.type
      : "unknown";
    return { status, latestTurnId, goal: goalSnapshot(goalResponse.goal) };
  }

  private async latestTurnId(rpc: RpcConnection, threadId: string): Promise<string | null> {
    try {
      const response = await rpc.call<{ data?: unknown[] }>("thread/turns/list", {
        threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      const first = Array.isArray(response.data) && isRecord(response.data[0])
        ? response.data[0]
        : null;
      return stringValue(first?.id);
    } catch {
      return null;
    }
  }

  private async submissionState(
    rpc: RpcConnection,
    wait: StoredWait,
  ): Promise<"found" | "missing" | "unknown"> {
    try {
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const response: { data?: unknown[]; nextCursor?: string | null } = await rpc.call(
          "thread/queue/list",
          { threadId: wait.threadId, limit: 100, ...(cursor ? { cursor } : {}) },
        );
        const entries: unknown[] = Array.isArray(response.data) ? response.data : [];
        if (entries.some((entry) => isRecord(entry) && entry.clientUserMessageId === wait.clientUserMessageId))
          return "found";
        cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
        if (!cursor) break;
      }

      cursor = null;
      for (let page = 0; page < 20; page += 1) {
        const response: { data?: unknown[]; nextCursor?: string | null } = await rpc.call(
          "thread/turns/list",
          { threadId: wait.threadId, limit: 100, sortDirection: "desc", itemsView: "full", ...(cursor ? { cursor } : {}) },
        );
        const entries: unknown[] = Array.isArray(response.data) ? response.data : [];
        if (entries.some((entry) => JSON.stringify(entry).includes(wait.clientUserMessageId)))
          return "found";
        cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
        if (!cursor) break;
      }
      return "missing";
    } catch {
      return "unknown";
    }
  }

  private remove(waitId: string): void {
    const index = this.data.waits.findIndex((wait) => wait.id === waitId);
    if (index >= 0) this.data.waits.splice(index, 1);
    const timer = this.timers.get(waitId);
    if (timer) clearTimeout(timer);
    this.timers.delete(waitId);
  }
}
