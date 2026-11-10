import { request as httpRequest } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import type { ScheduledTask } from "./scheduled-tasks.js";
import { currentDaemonThreadId, scheduledTaskInput } from "./scheduled-task-target.js";

type JsonRecord = Record<string, unknown>;

const scheduleSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["interval", "daily", "weekly"] },
    minutes: { type: "integer", minimum: 1, maximum: 10080 },
    time: { type: "string", description: "Local time in HH:mm format." },
    weekdays: {
      type: "array",
      items: {
        type: "string",
        enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
      },
      minItems: 1,
    },
  },
  required: ["type"],
} as const;

const taskProperties = {
  name: {
    type: "string",
    description: "Short name shown in the Scheduled sidebar.",
  },
  prompt: {
    type: "string",
    description: "Instructions Codex should run each time.",
  },
  mode: {
    type: "string",
    enum: ["sameChat", "newChat"],
    description:
      "Continue one conversation, or start a new conversation for every run.",
  },
  conversationLink: {
    type: "string",
    description:
      "For an explicitly chosen target: codex://threads/<UUID>. Omit when creating a sameChat task for the current conversation; the transport identifies it automatically. Never pass an application conv_ ID.",
  },
  useCurrentConversation: {
    type: "boolean",
    description:
      "For updates, true explicitly rebinds the task to this calling conversation. Otherwise updates keep the saved target. Cannot be combined with conversationLink.",
  },
  cwd: {
    type: "string",
    description:
      "Absolute project directory for newChat runs. Required for a new chat task.",
  },
  timezone: {
    type: "string",
    description: "IANA timezone for the recurrence, such as Asia/Singapore.",
  },
  schedule: scheduleSchema,
  model: {
    type: "string",
    description: "Optional model id. Omit to use the daemon default.",
  },
  reasoningEffort: {
    type: "string",
    description: "Optional reasoning effort. Omit to use the daemon default.",
  },
} as const;

const tools: Tool[] = [
  {
    name: "get_scheduled_task_context",
    description: "Read and verify this MCP call's current daemon conversation and Codex Link without changing or starting a task. Returns an error when caller identity is unavailable.",
    inputSchema: {type:"object", properties:{}, additionalProperties:false},
  },
  {
    name: "list_scheduled_tasks",
    description: "List scheduled tasks. Include archived tasks when requested.",
    inputSchema: {
      type: "object",
      properties: { includeArchived: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_scheduled_task",
    description:
      "Read a task, including every saved run and its conversation links.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_scheduled_task",
    description:
      "Create a recurring task. SameChat continues the current conversation; newChat starts a fresh conversation each run. Task runs use the daemon's current permission settings and cannot answer approval or input requests. Do not supply a thread ID: current conversation comes from transport metadata. Use conversationLink only for an explicitly selected conversation or when current identity is unavailable. The daemon verifies the target before saving.",
    inputSchema: {
      type: "object",
      properties: taskProperties,
      required: ["name", "prompt", "mode", "schedule"],
      additionalProperties: false,
    },
  },
  {
    name: "update_scheduled_task",
    description:
      "Update task instructions, recurrence, destination, project, model, or reasoning effort. Existing run history and conversation links are retained. Omitted fields and the existing destination are preserved. Use conversationLink to choose another conversation, or useCurrentConversation=true to explicitly rebind to the caller. The daemon verifies the target before saving.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, ...taskProperties },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "pause_scheduled_task",
    description: "Pause future scheduled runs while retaining task history.",
    inputSchema: taskIdSchema(),
  },
  {
    name: "resume_scheduled_task",
    description: "Resume a paused task with its saved recurrence.",
    inputSchema: taskIdSchema(),
  },
  {
    name: "run_scheduled_task_now",
    description:
      "Queue one immediate run without changing the saved recurrence.",
    inputSchema: taskIdSchema(),
  },
  {
    name: "archive_scheduled_task",
    description:
      "Archive a task without deleting its run history or conversation links.",
    inputSchema: taskIdSchema(),
  },
  {
    name: "restore_scheduled_task",
    description: "Restore an archived task and continue its saved recurrence.",
    inputSchema: taskIdSchema(),
  },
];

const server = new Server(
  { name: "codex-scheduled-tasks", version: "0.2.0" },
  {
    capabilities: { tools: { listChanged: false } },
    instructions:
      "Manage only scheduled tasks and their saved run history. Task run history is retained when tasks are edited, paused, or archived.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = request.params.arguments ?? {};
    const result = await callTaskControl(
      request.params.name,
      args,
      request.params._meta,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Scheduled task operation failed";
    return { isError: true, content: [{ type: "text", text: message }] };
  }
});

await server.connect(new StdioServerTransport());

async function callTaskControl(
  name: string,
  args: JsonRecord,
  metadata: unknown,
): Promise<unknown> {
  const meta = isRecord(metadata) ? metadata : {};
  const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
  if (name === "get_scheduled_task_context")
    return control({operation:"validateThread", id:currentDaemonThreadId(meta)});
  if (name === "list_scheduled_tasks") {
    const tasks = (
      await control<ScheduledTask[]>({
        operation: "list",
        includeArchived: args.includeArchived === true,
      })
    ).map(summarizeTask);
    return { tasks };
  }
  if (name === "get_scheduled_task")
    return control({ operation: "get", id: requireId(taskId) });
  if (name === "create_scheduled_task") {
    const input = scheduledTaskInput(args, meta);
    return control({ operation: "create", task: input });
  }
  if (name === "update_scheduled_task") {
    const existing = await control<ScheduledTask>({
      operation: "get",
      id: requireId(taskId),
    });
    const input = scheduledTaskInput(args, meta, existing);
    return control({ operation: "update", id: requireId(taskId), task: input });
  }
  const operations: Record<string, string> = {
    pause_scheduled_task: "pause",
    resume_scheduled_task: "resume",
    run_scheduled_task_now: "runNow",
    archive_scheduled_task: "archive",
    restore_scheduled_task: "restore",
  };
  const operation = operations[name];
  if (!operation) throw new Error("Unsupported scheduled task tool");
  return control({ operation, id: requireId(taskId) });
}

async function control<T = unknown>(body: JsonRecord): Promise<T> {
  const content = JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: config.scheduledTasksSocketPath,
        path: "/tasks",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(content),
        },
        timeout: 10_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          let result: unknown;
          try {
            result = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as unknown;
          } catch {
            reject(new Error("Task control returned invalid JSON"));
            return;
          }
          if (response.statusCode !== 200) {
            reject(
              new Error(
                isRecord(result) && typeof result.error === "string"
                  ? result.error
                  : "Task control failed",
              ),
            );
            return;
          }
          resolve((isRecord(result) ? result.result : undefined) as T);
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("Task control timed out")),
    );
    request.on("error", reject);
    request.end(content);
  });
}

function summarizeTask(task: ScheduledTask): JsonRecord {
  const latestRun = task.runs.at(-1);
  return {
    id: task.id,
    name: task.name,
    mode: task.mode,
    sourceThreadId: task.sourceThreadId,
    cwd: task.cwd,
    timezone: task.timezone,
    schedule: task.schedule,
    status: task.status,
    nextRunAt: task.nextRunAt,
    runCount: task.runs.length,
    latestRun: latestRun
      ? {
          scheduledAt: latestRun.scheduledAt,
          status: latestRun.status,
          threadId: latestRun.threadId,
          error: latestRun.error,
        }
      : null,
    pauseReason: task.pauseReason,
  };
}

function taskIdSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
    additionalProperties: false,
  };
}

function requireId(value: string | undefined): string {
  if (!value) throw new Error("taskId is required");
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
