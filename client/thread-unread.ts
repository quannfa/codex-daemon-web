import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { agentParentId } from "./project-sidebar";
import type { RpcClient } from "./protocol";
import type { ThreadSummary } from "./types";

export type ReplyRef = { turnId: string; itemId: string };
export type ThreadUnread = {
  replies: ReplyRef[];
  manual: { token: string; reply: ReplyRef | null } | null;
};
type Snapshot = { revision: number; threads: Record<string, ThreadUnread> };
type Mutation = { action: "unread" } |
  { action: "read"; replies: ReplyRef[]; through?: ReplyRef; manualToken?: string };

export const replyKey = ({ turnId, itemId }: ReplyRef) => JSON.stringify([turnId, itemId]);

export function useThreadUnreads(authenticated: boolean, online: boolean, revision: number) {
  const [threads, setThreads] = useState<Snapshot["threads"] | null>(null);
  const [ready, setReady] = useState(false);
  const lastRevision = useRef(-1);

  const apply = useCallback((snapshot: Snapshot) => {
    if (snapshot.revision < lastRevision.current) return;
    lastRevision.current = snapshot.revision;
    setThreads(snapshot.threads);
  }, []);

  useEffect(() => {
    lastRevision.current = -1;
    if (!authenticated) {
      setThreads(null);
      setReady(false);
    }
  }, [authenticated, online]);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    let controller: AbortController | undefined;
    const load = async () => {
      if (document.hidden || controller) return;
      controller = new AbortController();
      try {
        const response = await fetch("/api/thread-unreads", {
          credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error("Could not load unread conversations");
        const snapshot = await response.json() as Snapshot;
        if (active) apply(snapshot);
      } catch { /* The next focus or bridge update retries the snapshot. */ }
      finally {
        if (active) setReady(true);
        controller = undefined;
      }
    };
    void load();
    document.addEventListener("visibilitychange", load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      controller?.abort();
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener("focus", load);
    };
  }, [authenticated, online, revision, apply]);

  const mutate = useCallback(async (threadId: string, mutation: Mutation) => {
    const response = await fetch(`/api/thread-unreads/${encodeURIComponent(threadId)}`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000), body: JSON.stringify(mutation),
    });
    if (!response.ok) throw new Error("Could not update unread status");
    apply(await response.json() as Snapshot);
  }, [apply]);
  return { threads, ready, mutate };
}

type SidebarExtra = { thread: ThreadSummary; archived: boolean };

// Fetch only missing unread conversations and their ancestors, independently of
// the regular sidebar cursor (which can be many pages away from a child reply).
export function useUnreadSidebarThreads(client: RpcClient | null, online: boolean, archived: boolean,
  roots: ThreadSummary[], agents: ThreadSummary[], unreadIds: ReadonlySet<string>, archiveRevision: number) {
  const [extras, setExtras] = useState<{ revision: number; threads: Map<string, SidebarExtra> }>();
  const combined = useMemo(() => {
    const rootMap = new Map(roots.map(thread => [thread.id, thread]));
    const agentMap = new Map(agents.map(thread => [thread.id, thread]));
    if (extras?.revision === archiveRevision) {
      for (const [id, extra] of extras.threads) {
        if (extra.archived !== archived || rootMap.has(id) || agentMap.has(id)) continue;
        (agentParentId(extra.thread) ? agentMap : rootMap).set(id, extra.thread);
      }
    }
    return { roots: [...rootMap.values()], agents: [...agentMap.values()], known: new Map([...rootMap, ...agentMap]) };
  }, [roots, agents, extras, archived, archiveRevision]);

  useEffect(() => {
    if (!client || !online || !unreadIds.size) return;
    let cancelled = false;
    const cached = extras?.revision === archiveRevision ? extras.threads : undefined;
    const pending = new Map<string, Promise<ThreadSummary | undefined>>();
    const found = new Map<string, SidebarExtra>();
    const lookup = (id: string) => {
      const known = combined.known.get(id);
      if (known) return Promise.resolve(known);
      const extra = cached?.get(id);
      if (extra) return Promise.resolve(extra.archived === archived ? extra.thread : undefined);
      const existing = pending.get(id);
      if (existing) return existing;
      const request = client.request<{ thread: ThreadSummary & { path?: string | null } }>(
        "thread/read", { threadId: id, includeTurns: false },
      ).then(({ thread }) => {
        const isArchived = thread.archived ?? /(?:^|[\\/])archived_sessions[\\/]/.test(thread.path ?? "");
        found.set(id, { thread, archived: isArchived });
        return isArchived === archived ? thread : undefined;
      }).catch(() => undefined);
      pending.set(id, request);
      return request;
    };
    const followParents = async (id: string) => {
      const seen = new Set<string>();
      let next: string | null = id;
      while (next && !seen.has(next) && !cancelled) {
        seen.add(next);
        const thread = await lookup(next);
        next = thread ? agentParentId(thread) : null;
      }
    };
    void (async () => {
      const ids = [...unreadIds];
      for (let offset = 0; offset < ids.length && !cancelled; offset += 8)
        await Promise.all(ids.slice(offset, offset + 8).map(followParents));
      if (!cancelled && found.size) setExtras({ revision: archiveRevision, threads: new Map([...cached ?? [], ...found]) });
    })();
    return () => { cancelled = true; };
  }, [client, online, archived, unreadIds, archiveRevision, extras, combined.known]);

  return combined;
}

type Reading = {
  visit: number;
  positioned: boolean;
  manualToken?: string;
  requestedCursor?: string;
};

export function useUnreadTimeline({ threadId, visit, unread, ready, covered, items,
  cursor, loadOlder, timeline, nearBottom, markRead }: {
  threadId?: string;
  visit: number;
  unread?: ThreadUnread;
  ready: boolean;
  covered: boolean;
  items: unknown[];
  cursor: string | null;
  loadOlder: (reposition?: boolean) => Promise<void>;
  timeline: RefObject<HTMLDivElement | null>;
  nearBottom: RefObject<boolean>;
  markRead: (threadId: string, mutation: Mutation) => Promise<void>;
}) {
  const reading = useRef<Reading>({ visit, positioned: false });
  const writing = useRef(false);
  const [retry, setRetry] = useState(0);

  useLayoutEffect(() => {
    const view = timeline.current;
    if (!view || !threadId || !ready) return;
    if (reading.current.visit !== visit) reading.current = { visit, positioned: false };
    const position = reading.current;
    if (position.positioned) return;

    const first = unread?.replies[0] ?? unread?.manual?.reply;
    const key = first ? replyKey(first) : null;
    const anchor = key && [...view.querySelectorAll<HTMLElement>("[data-unread-reply]")]
      .find(element => element.dataset.unreadReply === key);
    if (key && !anchor && cursor) {
      if (position.requestedCursor === cursor) return;
      position.requestedCursor = cursor;
      void loadOlder(false);
      return;
    }
    position.positioned = true;
    position.manualToken = unread?.manual?.token;
    if (anchor) {
      nearBottom.current = false;
      const top = anchor.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop - 14;
      view.scrollTo({ top, behavior: "instant" });
    } else {
      nearBottom.current = true;
      view.scrollTo({ top: view.scrollHeight, behavior: "instant" });
    }
  }, [threadId, visit, unread, ready, items, cursor, loadOlder, timeline, nearBottom]);

  const allowsFollow = useCallback(
    () => !threadId || ready && reading.current.visit === visit && reading.current.positioned,
    [threadId, ready, visit],
  );

  useEffect(() => {
    const view = timeline.current;
    if (!view || !ready || !threadId || !unread || covered ||
        reading.current.visit !== visit || !reading.current.positioned) return;
    const pending = new Map(unread.replies.map(reply => [replyKey(reply), reply]));
    const manual = unread.manual?.token === reading.current.manualToken ? unread.manual : null;
    const manualKey = manual?.reply ? replyKey(manual.reply) : null;
    const tails = [...view.querySelectorAll<HTMLElement>("[data-unread-end]")].filter(element => {
      const key = element.dataset.unreadEnd ?? "";
      return pending.has(key) || key === manualKey;
    });
    let disposed = false;
    let timer: number | undefined;
    let backoff: number | undefined;
    let failed = false;
    const acknowledge = async () => {
      if (disposed || failed || writing.current || document.hidden || !document.hasFocus()) return;
      const root = view.getBoundingClientRect();
      const visible = tails.filter(element => {
        const rect = element.getBoundingClientRect();
        const viewportBottom = window.visualViewport
          ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight;
        const visibleTop = Math.max(window.visualViewport?.offsetTop ?? 0, root.top);
        if (rect.height <= 0 || rect.top < visibleTop || rect.bottom > Math.min(root.bottom, viewportBottom)) return false;
        const covering = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !!covering && view.contains(covering);
      }).map(element => element.dataset.unreadEnd ?? "");
      const replies = visible.flatMap(key => pending.has(key) ? [pending.get(key)!] : []).slice(0, 80);
      const manualToken = manual && (!manualKey || visible.includes(manualKey)) ? manual.token : undefined;
      if (!replies.length && !manualToken) return;
      writing.current = true;
      try { await markRead(threadId, { action: "read", replies, manualToken }); }
      catch { failed = true; }
      finally {
        writing.current = false;
        if (failed && !disposed) backoff = window.setTimeout(() => setRetry(value => value + 1), 3000);
        else if (disposed) setRetry(value => value + 1);
      }
    };
    const schedule = () => {
      if (disposed || failed || timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void acknowledge();
      }, 150);
    };
    const observer = new IntersectionObserver(schedule, { root: view, threshold: 1 });
    for (const tail of tails) observer.observe(tail);
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("focus", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    schedule();
    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(timer);
      window.clearTimeout(backoff);
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("focus", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [threadId, visit, unread, ready, covered, items, cursor, timeline, markRead, retry]);

  return allowsFollow;
}
