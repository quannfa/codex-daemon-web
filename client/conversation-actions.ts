/** Codex-native thread reference for sharing context with another Codex conversation.
 * It is not a browser URL and contains no credentials or conversation content. */
export function codexThreadLink(threadId:string):string{
  if(!/^[a-f0-9-]{20,}$/i.test(threadId))throw new Error("Invalid Codex thread ID.");
  return "codex://threads/"+threadId;
}

/** Codex app-server forks by turns, not arbitrary item IDs. */
export type ForkThreadSettings = {
  model?: string;
  modelProvider?: string;
  serviceTier?: string;
  cwd?: string;
  runtimeWorkspaceRoots?: string[];
  approvalPolicy?: unknown;
  approvalsReviewer?: "user" | "auto_review" | "guardian_subagent";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  permissions?: string;
  config?: Record<string, unknown>;
};

type ForkThreadSource = {
  model?: unknown;
  modelProvider?: unknown;
  serviceTier?: unknown;
  cwd?: unknown;
  runtimeWorkspaceRoots?: unknown;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandbox?: unknown;
  activePermissionProfile?: unknown;
  reasoningEffort?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function forkSandboxMode(value: unknown): ForkThreadSettings["sandbox"] {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "readOnly") return "read-only";
  if (value.type === "workspaceWrite") return "workspace-write";
  if (value.type === "dangerFullAccess") return "danger-full-access";
  return undefined;
}

function forkApprovalPolicy(value: unknown): unknown {
  if (value === "untrusted" || value === "on-request" || value === "never")
    return value;
  if (!isRecord(value) || !isRecord(value.granular)) return undefined;
  const granular = value.granular;
  const requiredKeys = [
    "sandbox_approval",
    "rules",
    "mcp_elicitations",
  ];
  if (
    !requiredKeys.every((key) => typeof granular[key] === "boolean") ||
    (granular.skill_approval !== undefined &&
      typeof granular.skill_approval !== "boolean") ||
    (granular.request_permissions !== undefined &&
      typeof granular.request_permissions !== "boolean")
  )
    return undefined;
  return {
    granular: {
      sandbox_approval: granular.sandbox_approval,
      rules: granular.rules,
      skill_approval: granular.skill_approval ?? false,
      request_permissions: granular.request_permissions ?? false,
      mcp_elicitations: granular.mcp_elicitations,
    },
  };
}

/**
 * Convert the daemon's effective thread settings into thread/fork overrides.
 * Fork does not expose an `effort` field; the app-server reads the model
 * reasoning setting from the generic config override.
 */
export function forkSettingsFromThread(
  source: ForkThreadSource,
): ForkThreadSettings {
  const settings: ForkThreadSettings = {};
  const model = nonEmptyString(source.model);
  const modelProvider = nonEmptyString(source.modelProvider);
  const serviceTier = nonEmptyString(source.serviceTier);
  const cwd = nonEmptyString(source.cwd);
  if (model) settings.model = model;
  if (modelProvider) settings.modelProvider = modelProvider;
  if (serviceTier) settings.serviceTier = serviceTier;
  if (cwd) settings.cwd = cwd;

  if (Array.isArray(source.runtimeWorkspaceRoots)) {
    const roots = source.runtimeWorkspaceRoots.filter(
      (root): root is string => typeof root === "string" && root.trim().length > 0,
    );
    if (roots.length === source.runtimeWorkspaceRoots.length)
      settings.runtimeWorkspaceRoots = roots;
  }

  const approvalPolicy = forkApprovalPolicy(source.approvalPolicy);
  if (approvalPolicy !== undefined) settings.approvalPolicy = approvalPolicy;
  if (
    source.approvalsReviewer === "user" ||
    source.approvalsReviewer === "auto_review" ||
    source.approvalsReviewer === "guardian_subagent"
  )
    settings.approvalsReviewer = source.approvalsReviewer;

  const profile = isRecord(source.activePermissionProfile)
    ? nonEmptyString(source.activePermissionProfile.id)
    : undefined;
  if (profile) settings.permissions = profile;
  else {
    const sandbox = forkSandboxMode(source.sandbox);
    if (sandbox) settings.sandbox = sandbox;
  }

  const reasoningEffort = nonEmptyString(source.reasoningEffort);
  if (reasoningEffort)
    settings.config = { model_reasoning_effort: reasoningEffort };
  return settings;
}

export function forkAtMessage(
  threadId:string,
  turnId:string,
  kind:"userMessage"|"agentMessage",
  options:{activeTurn?:boolean;settings?:ForkThreadSettings}={}
){
  if(!threadId||!turnId)throw new Error("This message has no saved Codex turn.");
  const history = kind==="agentMessage"&&options.activeTurn
    ? {threadId,excludeTurns:true}
    : kind==="userMessage"
    ? {threadId,beforeTurnId:turnId,excludeTurns:true}
    : {threadId,lastTurnId:turnId,excludeTurns:true};
  return {...history,...(options.settings ?? {})};
}

/**
 * An assistant item belongs to the active turn when its turn id matches the
 * turn tracked by the app. In that case thread/fork must omit lastTurnId.
 */
export function isActiveAssistantTurn(
  turnId:string|undefined,
  kind:"userMessage"|"agentMessage",
  activeTurnId:string|null|undefined,
):boolean {
  if(kind!=="agentMessage"||!turnId)return false;
  return activeTurnId===turnId;
}
