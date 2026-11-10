import { AppServerRpc } from "./app-server-rpc.js";
import type { ScheduledTask, ScheduledTaskInput } from "./scheduled-tasks.js";

type Fields = Record<string, unknown>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function daemonThreadId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value.trim()))
    throw new Error("A daemon conversation UUID is required. An application conv_ ID is not a daemon thread ID; use the conversation's Codex Link.");
  return value.trim().toLowerCase();
}

export function threadIdFromCodexLink(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("conversationLink must be a codex://threads/<UUID> link.");
  const match = /^codex:\/\/threads\/([^/?#]+)\/?$/.exec(value.trim());
  if (!match) throw new Error("conversationLink must be a codex://threads/<UUID> link.");
  return daemonThreadId(match[1]);
}

export function currentDaemonThreadId(metadata: Fields): string {
  // Only transport metadata can identify the caller. Never use model arguments
  // or process-wide environment variables as the current conversation.
  for (const value of [metadata.threadId, metadata.thread_id, metadata.session_id]) {
    try { return daemonThreadId(value); } catch { /* Try the other transport field. */ }
  }
  throw new Error("The MCP call does not identify a valid current daemon conversation. Provide its Codex Link in conversationLink; do not guess or use a conv_ ID.");
}

export async function verifyDaemonThread(
  id: string,
  connect: typeof AppServerRpc.connect = AppServerRpc.connect,
): Promise<void> {
  const threadId = daemonThreadId(id);
  const rpc = await connect();
  try {
    const result = await rpc.call<{thread:{id:string}}>("thread/read", {threadId, includeTurns:false});
    if (daemonThreadId(result.thread?.id) !== threadId)
      throw new Error("The daemon returned a different conversation.");
  } finally { rpc.close(); }
}

export function scheduledTaskInput(
  args: Fields,
  metadata: Fields,
  existing?: ScheduledTask,
): ScheduledTaskInput {
  if (Object.prototype.hasOwnProperty.call(args, "threadId"))
    throw new Error("threadId is no longer accepted by the MCP tool. Omit the target to use the current conversation when creating a task, or supply conversationLink: codex://threads/<UUID>.");
  if (args.useCurrentConversation !== undefined && typeof args.useCurrentConversation !== "boolean")
    throw new Error("useCurrentConversation must be a boolean.");
  const mode = args.mode ?? existing?.mode;
  const hasLink = Object.prototype.hasOwnProperty.call(args, "conversationLink");
  if (hasLink && args.useCurrentConversation === true)
    throw new Error("Choose either conversationLink or useCurrentConversation, not both.");
  let threadId: string | undefined;
  if (mode === "sameChat") {
    if (hasLink) threadId = threadIdFromCodexLink(args.conversationLink);
    else if (args.useCurrentConversation === true || !existing || existing.mode !== "sameChat")
      threadId = currentDaemonThreadId(metadata);
    else threadId = daemonThreadId(existing.sourceThreadId);
  } else if (hasLink || args.useCurrentConversation === true) {
    throw new Error("Conversation targets apply only to sameChat tasks.");
  }
  return {
    name: args.name ?? existing?.name,
    prompt: args.prompt ?? existing?.prompt,
    mode,
    threadId,
    cwd: args.cwd ?? (existing ? existing.cwd : metadata.cwd),
    timezone: args.timezone ?? existing?.timezone,
    schedule: args.schedule ?? existing?.schedule,
    model: args.model ?? existing?.model,
    reasoningEffort: args.reasoningEffort ?? existing?.reasoningEffort,
  };
}
