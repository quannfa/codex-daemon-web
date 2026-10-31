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
