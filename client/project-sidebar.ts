import type { ThreadSummary } from "./types";

export type ProjectSort = "recent" | "name";
export type ProjectPreferences = {
  collapsed: Record<string, boolean>;
  sort: ProjectSort;
};
export const projectPreferencesKey = "codex-web.project-sidebar.v1";

export function readProjectPreferences(storage: Pick<Storage, "getItem">): ProjectPreferences {
  try {
    const value = JSON.parse(storage.getItem(projectPreferencesKey) || "null");
    const collapsed: Record<string, boolean> = Object.create(null);
    if (value?.collapsed && typeof value.collapsed === "object" && !Array.isArray(value.collapsed)) {
      for (const [key, state] of Object.entries(value.collapsed)) {
        if (typeof state === "boolean") collapsed[key] = state;
      }
    }
    return { collapsed, sort: value?.sort === "name" ? "name" : "recent" };
  } catch {
    return { collapsed: {}, sort: "recent" };
  }
}

function activity(thread: ThreadSummary, archived: boolean): number {
  const value = (archived ? thread.updatedAt : thread.recencyAt) ?? thread.updatedAt ?? thread.createdAt;
  return Number.isFinite(value) && value > 0 ? (value < 1e12 ? value * 1000 : value) : 0;
}

export type SidebarMembership = {
  projectlessThreadIds: string[];
  projectThreadIds: string[];
};

export function projectCwdFor(thread: ThreadSummary, membership?: SidebarMembership): string {
  if (membership?.projectlessThreadIds.includes(thread.id)) return "";
  const cwd = thread.cwd || "";
  if (membership?.projectThreadIds.includes(thread.id)) return cwd;
  // Projectless chats receive dated output directories even though no project
  // was selected. Normalize separators only for detection; preserve real cwd keys.
  const path = cwd.replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/+$/, "");
  if (!path) return "";
  if (/(?:^|\/)Documents\/Codex(?:\/\d{4}-\d{2}-\d{2}(?:\/.*)?)?$/i.test(path)) return "";
  if (/^(?:\/home\/[^/]+|\/Users\/[^/]+|[a-z]:\/Users\/[^/]+|\/tmp|\/var\/tmp|\/)$/i.test(path)) return "";
  return cwd;
}

export function groupProjectThreads(threads: ThreadSummary[], sort: ProjectSort, archived: boolean, membership?: SidebarMembership) {
  const groups = new Map<string, { cwd: string; name: string; threads: ThreadSummary[]; activity: number }>();
  for (const thread of threads) {
    const cwd = projectCwdFor(thread, membership);
    let group = groups.get(cwd);
    if (!group) {
      group = { cwd, name: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd || "No project", threads: [], activity: 0 };
      groups.set(cwd, group);
    }
    group.threads.push(thread);
    group.activity = Math.max(group.activity, activity(thread, archived));
  }
  const byName = (a: { name: string; cwd: string }, b: { name: string; cwd: string }) =>
    a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd);
  for (const group of groups.values()) {
    group.threads.sort((a, b) => activity(b, archived) - activity(a, archived) || a.id.localeCompare(b.id));
  }
  return [...groups.values()].sort((a, b) =>
    (sort === "recent" ? b.activity - a.activity : 0) || byName(a, b));
}

// Subagent threads are excluded from the default thread/list sources. Their
// parent relationship is stored in source.subAgent.thread_spawn on this daemon.
export const subagentSourceKinds = [
  "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther",
];

export function agentParentId(thread: ThreadSummary): string | null {
  if (thread.parentThreadId) return thread.parentThreadId;
  const source = thread.source;
  if (typeof source === "object" && source?.subAgent?.thread_spawn?.parent_thread_id)
    return source.subAgent.thread_spawn.parent_thread_id;
  return null;
}

export function agentDisplayName(thread: ThreadSummary): string | null {
  if (thread.agentNickname) return thread.agentNickname;
  const source = thread.source;
  return typeof source === "object" ? source?.subAgent?.thread_spawn?.agent_nickname || null : null;
}

export type ThreadTreeRow = {
  thread: ThreadSummary;
  depth: number;
  childCount: number;
  expanded: boolean;
};

export function agentAncestorIds(agents: ThreadSummary[], query: string): Set<string> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const ancestors = new Set<string>();
  for (const agent of agents) {
    if (!`${agent.name || ""} ${agent.preview} ${agent.cwd} ${agentDisplayName(agent) || ""}`.toLowerCase().includes(query)) continue;
    let parent = agentParentId(agent);
    const seen = new Set([agent.id]);
    while (parent && !seen.has(parent)) {
      ancestors.add(parent);
      seen.add(parent);
      parent = byId.has(parent) ? agentParentId(byId.get(parent)!) : null;
    }
  }
  return ancestors;
}

export function buildAgentTreeRows(
  roots: ThreadSummary[], agents: ThreadSummary[], collapsed: Record<string, boolean>,
  archived: boolean, query = "",
): ThreadTreeRow[] {
  const byParent = new Map<string, ThreadSummary[]>();
  const rootIds = new Set(roots.map((thread) => thread.id));
  const agentIds = new Set(agents.map((agent) => agent.id));
  for (const agent of agents) {
    const parent = agentParentId(agent);
    if (!parent || parent === agent.id || (!rootIds.has(parent) && !agentIds.has(parent))) continue;
    const children = byParent.get(parent) || [];
    children.push(agent);
    byParent.set(parent, children);
  }
  for (const children of byParent.values()) {
    children.sort((a,b) => activity(b,archived)-activity(a,archived) || a.id.localeCompare(b.id));
  }
  const matches = (thread: ThreadSummary) =>
    `${thread.name || ""} ${thread.preview} ${thread.cwd} ${agentDisplayName(thread) || ""}`.toLowerCase().includes(query);
  const ancestors = query ? agentAncestorIds(agents, query) : new Set<string>();
  const rows: ThreadTreeRow[] = [];
  const visit = (thread: ThreadSummary, depth: number, inheritedMatch: boolean, path: Set<string>) => {
    if (path.has(thread.id)) return;
    const ownMatch = Boolean(query && matches(thread));
    if (query && !inheritedMatch && !ownMatch && !ancestors.has(thread.id)) return;
    const children = byParent.get(thread.id) || [];
    const expanded = Boolean(query) || !collapsed[thread.id];
    rows.push({thread, depth, childCount:children.length, expanded});
    if (!expanded) return;
    const nextPath = new Set(path); nextPath.add(thread.id);
    for (const child of children) visit(child, depth+1, inheritedMatch || ownMatch, nextPath);
  };
  for (const root of roots) visit(root,0,false,new Set());
  return rows;
}
