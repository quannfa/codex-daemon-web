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

export function groupProjectThreads(threads: ThreadSummary[], sort: ProjectSort, archived: boolean) {
  const groups = new Map<string, { cwd: string; name: string; threads: ThreadSummary[]; activity: number }>();
  for (const thread of threads) {
    const cwd = thread.cwd || "";
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
