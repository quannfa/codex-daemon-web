type ThreadResumeShape = {
  cwd?: unknown;
  runtimeWorkspaceRoots?: unknown;
  thread?: {
    id?: unknown;
    cwd?: unknown;
    status?: unknown;
  };
};

type ThreadRequester = {
  request<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function runtimeWorkspaceRootsFromResponse(
  response: ThreadResumeShape,
): string[] {
  if (Array.isArray(response.runtimeWorkspaceRoots)) {
    return response.runtimeWorkspaceRoots.filter(
      (root): root is string => typeof root === "string" && root.trim().length > 0,
    );
  }
  const cwd =
    typeof response.cwd === "string"
      ? response.cwd
      : typeof response.thread?.cwd === "string"
        ? response.thread.cwd
        : "";
  return cwd.trim() ? [cwd] : [];
}

export function hasRuntimeWorkspaceRoot(
  response: ThreadResumeShape,
  root: string,
): boolean {
  return runtimeWorkspaceRootsFromResponse(response).includes(root);
}

export function threadResumeIsActive(response: ThreadResumeShape): boolean {
  return (
    isRecord(response.thread?.status) && response.thread.status.type === "active"
  );
}

/**
 * Add a root to an idle thread without losing the daemon's existing roots.
 * The app-server ignores configuration overrides while this connection is
 * subscribed, so unsubscribe and resume are deliberately one ordered pair.
 * Active turns cannot be rebuilt; callers must wait for the turn to finish.
 */
export async function ensureRuntimeWorkspaceRoot<
  T extends ThreadResumeShape,
>(
  requester: ThreadRequester,
  threadId: string,
  root: string,
  initialResponse?: T,
): Promise<T> {
  let response =
    initialResponse ??
    (await requester.request<T>("thread/resume", {
      threadId,
      excludeTurns: true,
    }));
  if (!root || hasRuntimeWorkspaceRoot(response, root)) return response;
  if (threadResumeIsActive(response)) return response;

  const roots = [...runtimeWorkspaceRootsFromResponse(response), root].filter(
    (value, index, values) => values.indexOf(value) === index,
  );
  await requester.request("thread/unsubscribe", { threadId });
  response = await requester.request<T>("thread/resume", {
    threadId,
    excludeTurns: true,
    runtimeWorkspaceRoots: roots,
  });
  return response;
}
