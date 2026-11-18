import { SharedUploads } from "./shared-uploads.js";
import { ConversationShares } from "./conversation-shares.js";
import { SharedConversationGateway } from "./shared-conversation.js";
import { mountConversationShares } from "./share-routes.js";
import { ResourceStore, mountResources } from "./resources.js";
import { SessionUploads } from "./session-uploads.js";
import { mountSessionUploads } from "./session-upload-routes.js";
import "dotenv/config";
import { readSidebarMetadata } from "./sidebar-metadata.js";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { attachBridge } from "./bridge.js";
import {
  authenticatedSession,
  login,
  logout,
  prepareAuthentication,
  renewSessionCookie,
} from "./auth.js";
import { config } from "./config.js";
import { daemonAvailable, endpointLabel } from "./daemon.js";
import { ScheduledTaskScheduler } from "./scheduled-task-scheduler.js";
import { GoalWaitManager } from "./goal-wait-manager.js";
import { SubagentReturnLoop } from "./subagent-return-loop.js";
import { isReplyRef, ThreadUnreadStore, ThreadUnreadTracker } from "./thread-unread.js";
import { daemonThreadId } from "./scheduled-task-target.js";
import { AppServerRpc } from "./app-server-rpc.js";
import {
  startScheduledTaskControlSocket,
  stopScheduledTaskControlSocket,
} from "./scheduled-task-control.js";
import {
  ScheduledTaskStore,
  TaskNotFoundError,
  TaskValidationError,
  type ScheduledTaskInput,
} from "./scheduled-tasks.js";
import {
  deletePushSubscription,
  pushConfiguration,
  savePushSubscription,
} from "./push.js";
import {
  callBrowserBackend,
  writeBrowserError,
  type BrowserMethod,
} from "./browser-control.js";

const app = express();
const server = createServer(app);
const scheduledTaskStore = new ScheduledTaskStore(config.scheduledTasksPath);
const goalWaits = new GoalWaitManager(config.goalWaitsPath);
const unreadStore = new ThreadUnreadStore(resolve(dirname(config.tokenPath), "thread-unread.json"), () => bridge.notifyUnread());
const unreadTracker = new ThreadUnreadTracker(unreadStore);
const scheduledTaskScheduler = new ScheduledTaskScheduler(scheduledTaskStore,Date.now,AppServerRpc.connect);
const subagentReturnLoop = new SubagentReturnLoop(config.subagentReturnPath,()=>AppServerRpc.connect(),
  threadId=>goalWaits.waitStatus(threadId)!==null);

function originAllowed(origin: string | undefined): boolean {
  return Boolean(origin && config.allowedOrigins.has(origin));
}

function scheduledTaskId(request: express.Request): string {
  const id = request.params.id;
  if (typeof id !== "string")
    throw new TaskValidationError("Scheduled task id is invalid");
  return id;
}

function requireBrowserOrigin(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (!originAllowed(request.header("origin"))) {
    response.status(403).json({ error: "Request origin is not allowed" });
    return;
  }
  next();
}

async function requireSession(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const session = authenticatedSession(request);
  if (!session) {
    response.status(401).json({ authenticated: false });
    return;
  }
  if (!(await renewSessionCookie(session, response))) {
    response.status(401).json({ authenticated: false });
    return;
  }
  next();
}

async function statusPayload(request?: express.Request) {
  const available = await daemonAvailable();
  const session = request ? authenticatedSession(request) : null;
  return {
    authenticated: true,
    ...(session
      ? { runtimeWorkspaceRoot: sessionUploads.runtimeWorkspaceRoot(session) }
      : {}),
    sidebar: await readSidebarMetadata(),
    daemon: {
      available,
      ...(available ? {} : { error: "Codex app-server is unavailable" }),
      endpoint: endpointLabel(),
    },
  };
}

app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});
// Allow 8,000 Unicode characters in guest messages without enlarging other APIs.
app.use("/api/shared/messages", express.json({ limit: "64kb", strict: true }));
app.use(express.json({ limit: "16kb", strict: true }));
const resourceStore = new ResourceStore(resolve(dirname(config.tokenPath), "resources.json"), config.endpoint.kind === "unix");
await resourceStore.initialize();
mountResources(app, resourceStore, requireSession, requireBrowserOrigin);
const sessionUploads = new SessionUploads(
  config.sessionUploadsPath,
  resolve(dirname(config.tokenPath), "..", "codex-daemon-web-session-uploads"),
  config.endpoint.kind === "unix",
);
await sessionUploads.initialize();
const sessionUploadPruneTimer = setInterval(
  () => void sessionUploads.prune().catch(() => undefined),
  3600_000,
);
sessionUploadPruneTimer.unref();
mountSessionUploads(app, sessionUploads, requireSession, requireBrowserOrigin);
const conversationShares = new ConversationShares(resolve(dirname(config.tokenPath),"conversation-shares.json"));
await conversationShares.initialize();
const sharedUploads = new SharedUploads(resolve(dirname(config.tokenPath),"shared-uploads.json"),
  resolve(dirname(config.tokenPath),"..","codex-daemon-web-uploads"),conversationShares,config.endpoint.kind==="unix");
await sharedUploads.initialize();
const uploadPruneTimer=setInterval(()=>void sharedUploads.prune().catch(()=>{}),3600_000);
uploadPruneTimer.unref();
const sharedConversations = new SharedConversationGateway(conversationShares,undefined,undefined,sharedUploads);
mountConversationShares(app,conversationShares,sharedConversations,requireSession,requireBrowserOrigin,resourceStore,sharedUploads);


app.post(
  "/api/login",
  requireBrowserOrigin,
  async (request, response, next) => {
    try {
      const succeeded = await login(request, response, request.body?.token);
      if (!succeeded) return;
      response.json(await statusPayload(request));
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/subagent-returns/status", requireSession, (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ ...subagentReturnLoop.status(), configured: config.subagentReturnEnabled });
});

app.get("/api/status", requireSession, async (request, response, next) => {
  try {
    response.json(await statusPayload(request));
  } catch (error) {
    next(error);
  }
});

app.get("/api/goal-waits", requireSession, (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({
    waitingThreadIds: goalWaits.waitingThreadIds(),
    serverNow: Date.now(),
  });
});

app.get("/api/thread-unreads", requireSession, (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(unreadStore.snapshot());
});

app.post("/api/thread-unreads/:threadId", requireBrowserOrigin, requireSession, async (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  let threadId: string;
  try { threadId = daemonThreadId(request.params.threadId); }
  catch { response.status(400).json({ error: "Invalid conversation ID." }); return; }
  const { action, replies, through, manualToken } = request.body ?? {};
  try {
    if (action === "unread") {
      const latest = await unreadTracker.latestReply(threadId);
      await unreadStore.markUnread(threadId, latest);
    } else if (action === "read" && Array.isArray(replies) && replies.length <= 200 &&
        replies.every(isReplyRef) && (through == null || isReplyRef(through)) &&
        (manualToken === undefined || (typeof manualToken === "string" && manualToken.length <= 64))) {
      await unreadStore.acknowledge(threadId, replies, through ?? null, manualToken);
    } else {
      response.status(400).json({ error: "Invalid unread action." });
      return;
    }
    response.json(unreadStore.snapshot());
  } catch (error) { next(error); }
});

app.get("/api/goal-waits/:threadId", requireSession, (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  try {
    response.json({
      wait: goalWaits.waitStatus(request.params.threadId),
      serverNow: Date.now(),
    });
  } catch {
    response.status(400).json({ error: "Invalid conversation ID." });
  }
});

app.delete(
  "/api/goal-waits/:threadId",
  requireBrowserOrigin,
  requireSession,
  async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const threadId = request.params.threadId;
      if (typeof threadId !== "string") throw new Error("Invalid conversation ID");
      response.json({ cancelled: await goalWaits.cancel(threadId) });
    } catch {
      response.status(400).json({ error: "Invalid conversation ID." });
    }
  },
);

app.get("/api/browser/tabs", requireSession, async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const session = authenticatedSession(request);
  if (!session) return response.status(401).json({ authenticated: false });
  try {
    response.json(await callBrowserBackend(session, "webGetTabs"));
  } catch (error) {
    writeBrowserError(error, response);
  }
});

app.get(
  "/api/browser/tabs/:id/screenshot",
  requireSession,
  async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const session = authenticatedSession(request);
    if (!session) return response.status(401).json({ authenticated: false });
    const tabId = browserTabId(request.params.id);
    if (!tabId)
      return response.status(400).json({ error: "Invalid browser tab" });
    try {
      response.json(
        await callBrowserBackend(session, "webScreenshot", { tabId }),
      );
    } catch (error) {
      writeBrowserError(error, response);
    }
  },
);

app.post(
  "/api/browser/tabs",
  requireBrowserOrigin,
  requireSession,
  async (request, response) => {
    const session = authenticatedSession(request);
    if (!session) return response.status(401).json({ authenticated: false });
    if (request.body?.action !== "new") {
      return response.status(400).json({ error: "Invalid browser tab action" });
    }
    try {
      response.status(201).json(await callBrowserBackend(session, "webNewTab"));
    } catch (error) {
      writeBrowserError(error, response);
    }
  },
);

app.post(
  "/api/browser/tabs/:id",
  requireBrowserOrigin,
  requireSession,
  async (request, response) => {
    const session = authenticatedSession(request);
    if (!session) return response.status(401).json({ authenticated: false });
    const tabId = browserTabId(request.params.id);
    if (!tabId)
      return response.status(400).json({ error: "Invalid browser tab" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const actions: Record<string, BrowserMethod> = {
      select: "webActivateTab",
      navigate: "webNavigate",
      reload: "webReload",
      back: "webBack",
      click: "webClick",
      scroll: "webScroll",
      type: "webType",
      key: "webKey",
    };
    const method = actions[body.action as string];
    if (!method)
      return response.status(400).json({ error: "Invalid browser action" });
    try {
      response.json(
        await callBrowserBackend(session, method, { ...body, tabId }),
      );
    } catch (error) {
      writeBrowserError(error, response);
    }
  },
);

app.get(
  "/api/push/config",
  requireSession,
  async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await pushConfiguration());
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/push/subscription",
  requireBrowserOrigin,
  requireSession,
  async (request, response, next) => {
    try {
      response.status(201).json(await savePushSubscription(request.body));
    } catch (error) {
      next(error);
    }
  },
);

app.delete(
  "/api/push/subscription",
  requireBrowserOrigin,
  requireSession,
  async (request, response, next) => {
    try {
      response.json(await deletePushSubscription(request.body?.endpoint));
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/scheduled-tasks",
  requireSession,
  async (request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(
        await scheduledTaskStore.list(request.query.includeArchived === "true"),
      );
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/scheduled-tasks/:id",
  requireSession,
  async (request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await scheduledTaskStore.get(scheduledTaskId(request)));
    } catch (error) {
      sendTaskError(error, response, next);
    }
  },
);

app.post(
  "/api/scheduled-tasks",
  requireBrowserOrigin,
  requireSession,
  async (request, response, next) => {
    try {
      const task = await scheduledTaskStore.create(
        request.body as ScheduledTaskInput,
      );
      void scheduledTaskScheduler.wake();
      response.status(201).json(task);
    } catch (error) {
      sendTaskError(error, response, next);
    }
  },
);

app.patch(
  "/api/scheduled-tasks/:id",
  requireBrowserOrigin,
  requireSession,
  async (request, response, next) => {
    try {
      const task = await scheduledTaskStore.update(
        scheduledTaskId(request),
        request.body as ScheduledTaskInput,
      );
      void scheduledTaskScheduler.wake();
      response.json(task);
    } catch (error) {
      sendTaskError(error, response, next);
    }
  },
);

for (const [action, status] of [
  ["pause", "paused"],
  ["resume", "active"],
  ["archive", "archived"],
  ["restore", "active"],
] as const) {
  app.post(
    `/api/scheduled-tasks/:id/${action}`,
    requireBrowserOrigin,
    requireSession,
    async (request, response, next) => {
      try {
        const task = await scheduledTaskStore.setStatus(
          scheduledTaskId(request),
          status,
        );
        if (status === "active") void scheduledTaskScheduler.wake();
        response.json(task);
      } catch (error) {
        sendTaskError(error, response, next);
      }
    },
  );
}

app.post(
  "/api/scheduled-tasks/:id/run-now",
  requireBrowserOrigin,
  requireSession,
  async (request, response, next) => {
    try {
      const task = await scheduledTaskStore.requestRunNow(
        scheduledTaskId(request),
      );
      void scheduledTaskScheduler.wake();
      response.json(task);
    } catch (error) {
      sendTaskError(error, response, next);
    }
  },
);

app.post(
  "/api/logout",
  requireBrowserOrigin,
  requireSession,
  async (request, response) => logout(request, response),
);

app.use("/api", (_request, response) =>
  response.status(404).json({ error: "API route not found" }),
);

function browserTabId(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d{0,8}$/.test(value)) return null;
  const tabId = Number(value);
  return Number.isSafeInteger(tabId) ? tabId : null;
}

if (process.env.NODE_ENV !== "development") {
  const serverDirectory = dirname(fileURLToPath(import.meta.url));
  const clientDirectory = resolve(serverDirectory, "../client");
  const entryFile = resolve(clientDirectory, "index.html");
  if (existsSync(entryFile)) {
    app.get("/", (_request, response) => { response.setHeader("Cache-Control", "no-store"); response.sendFile(entryFile, { dotfiles: "allow" }); });
    app.use(
      express.static(clientDirectory, {
        index: false,
        fallthrough: true,
        maxAge: "1h",
        setHeaders: (response, path) => {
          if (path.endsWith("/service-worker.js")) {
            response.setHeader("Cache-Control", "no-cache");
          }
        },
      }),
    );
    app.get("/{*path}", (_request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      response.sendFile(entryFile, { dotfiles: "allow" }, (error) => {
        if (error) next(error);
      });
    });
  }
}

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    if (response.headersSent) return;
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : 500;
    response
      .status(status >= 400 && status < 600 ? status : 500)
      .json({ error: "Request could not be completed" });
  },
);

const bridge = attachBridge(server, threadId => unreadTracker.notify(threadId));

await prepareAuthentication();
await scheduledTaskStore.initialize();
await unreadStore.initialize();
unreadTracker.start();
await goalWaits.start();
await scheduledTaskScheduler.start();
if (config.subagentReturnEnabled) await subagentReturnLoop.start();
const scheduledTaskControlSocket = await startScheduledTaskControlSocket(
  scheduledTaskStore,
  scheduledTaskScheduler,
  goalWaits,
);
server.listen(config.port, config.host, () => {
  process.stdout.write(
    `Codex Daemon Web listening on http://${config.host}:${config.port}\n`,
  );
  if (!config.configuredAccessToken) {
    process.stdout.write(`Access token file: ${config.tokenPath}\n`);
  }
});

function shutdown(): void {
  clearInterval(uploadPruneTimer);
  clearInterval(sessionUploadPruneTimer);
  sharedConversations.close();
  goalWaits.stop();
  scheduledTaskScheduler.stop();
  unreadTracker.stop();
  subagentReturnLoop.stop();
  bridge.close();
  void stopScheduledTaskControlSocket(scheduledTaskControlSocket).catch(
    () => undefined,
  );
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function sendTaskError(
  error: unknown,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (error instanceof TaskValidationError) {
    response.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof TaskNotFoundError) {
    response.status(404).json({ error: error.message });
    return;
  }
  next(error);
}
