import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureRuntimeWorkspaceRoot,
  hasRuntimeWorkspaceRoot,
  runtimeWorkspaceRootsFromResponse,
} from "../client/thread-runtime-roots";

test("idle thread roots are replaced only after unsubscribe and retain existing roots", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const requester = {
    async request<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "thread/unsubscribe") return { status: "unsubscribed" } as T;
      return {
        thread: { id: "thread-1", status: { type: "idle" }, cwd: "/workspace" },
        cwd: "/workspace",
        runtimeWorkspaceRoots:
          Array.isArray(params.runtimeWorkspaceRoots)
            ? params.runtimeWorkspaceRoots
            : ["/workspace", "/existing"],
      } as T;
    },
  };

  const result = await ensureRuntimeWorkspaceRoot(
    requester,
    "thread-1",
    "/uploads/session",
  );
  assert.deepEqual(calls.map((call) => call.method), [
    "thread/resume",
    "thread/unsubscribe",
    "thread/resume",
  ]);
  assert.deepEqual(calls[2].params.runtimeWorkspaceRoots, [
    "/workspace",
    "/existing",
    "/uploads/session",
  ]);
  assert.equal(hasRuntimeWorkspaceRoot(result, "/uploads/session"), true);
});

test("active thread roots are left unchanged until the turn finishes", async () => {
  const methods: string[] = [];
  const requester = {
    async request<T>(method: string) {
      methods.push(method);
      return {
        thread: { id: "thread-1", status: { type: "active" } },
        runtimeWorkspaceRoots: ["/workspace"],
      } as T;
    },
  };
  const initial = await requester.request<{
    thread: { id: string; status: { type: string } };
    runtimeWorkspaceRoots: string[];
  }>("thread/resume");
  const result = await ensureRuntimeWorkspaceRoot(
    requester,
    "thread-1",
    "/uploads/session",
    initial,
  );
  assert.deepEqual(methods, ["thread/resume"]);
  assert.deepEqual(runtimeWorkspaceRootsFromResponse(result), ["/workspace"]);
});
