import assert from "node:assert/strict";
import test from "node:test";
import { groupProjectThreads, readProjectPreferences, projectCwdFor } from "../client/project-sidebar";
import type { ThreadSummary } from "../client/types";

const thread = (id: string, cwd: string, recencyAt: number | null = 10, updatedAt = 5) =>
  ({ id, cwd, recencyAt, updatedAt, createdAt: 1 } as ThreadSummary);

test("groups by complete cwd, keeps namesakes separate, handles missing cwd and Windows paths", () => {
  const groups = groupProjectThreads([
    thread("1", "/a/app"), thread("2", "/b/app"), thread("3", ""),
    thread("4", "/a/app"), thread("5", "C:\\code\\demo"),
  ], "name", false);
  assert.equal(groups.length, 4);
  assert.equal(groups.find(g => g.cwd === "/a/app")?.threads.length, 2);
  assert.equal(groups.find(g => !g.cwd)?.name, "No project");
  assert.equal(groups.find(g => g.cwd.startsWith("C:"))?.name, "demo");
});

test("sorts projects and threads by activity without mutating source; archives use updatedAt", () => {
  const source = [thread("old", "/z", 1, 30), thread("new", "/z", 20, 2), thread("a", "/a", 10, 10)];
  const before = [...source];
  assert.deepEqual(groupProjectThreads(source, "recent", false).map(g => g.cwd), ["/z", "/a"]);
  assert.deepEqual(groupProjectThreads(source, "recent", false)[0].threads.map(t => t.id), ["new", "old"]);
  assert.deepEqual(groupProjectThreads(source, "name", false).map(g => g.cwd), ["/a", "/z"]);
  assert.equal(groupProjectThreads(source, "recent", true)[0].threads[0].id, "old");
  assert.deepEqual(source, before);
});

test("normalizes seconds and milliseconds, handles missing activity and deterministic ties", () => {
  const groups = groupProjectThreads([thread("b", "/b", 1700000000), thread("a", "/a", 1700000000000), thread("c", "/c", null, 1800000000)], "recent", false);
  assert.deepEqual(groups.map(g => g.cwd), ["/c", "/a", "/b"]);
});

test("reads persisted preferences defensively and tolerates blocked storage", () => {
  const read = (value: string | null) => readProjectPreferences({ getItem: () => value });
  assert.deepEqual(read(null), { collapsed: Object.create(null), sort: "recent" });
  assert.deepEqual(read("{"), { collapsed: {}, sort: "recent" });
  assert.deepEqual(readProjectPreferences({ getItem: () => { throw Error("denied"); } }), { collapsed: {}, sort: "recent" });
  const stored = read('{"sort":"name","collapsed":{"/a":true,"/b":false,"/bad":"yes","__proto__":true}}');
  assert.equal(stored.sort, "name");
  assert.equal(stored.collapsed["/a"], true);
  assert.equal(stored.collapsed["/b"], false);
  assert.equal(stored.collapsed["/bad"], undefined);
  assert.equal(stored.collapsed["__proto__"], true);
  assert.equal(read('{"sort":"invalid","collapsed":[]}').sort, "recent");
});

test("projectless generated directories collapse into one group on Linux and Windows", () => {
  const win = (path: string) => path.replaceAll("/", String.fromCharCode(92));
  const paths = [
    "/home/zqf/Documents/Codex/2026-10-31/chat-one",
    "/home/zqf/Documents/Codex/2026-10-30/chat-two/outputs",
    win("C:/Users/Alice/Documents/Codex/2026-10-31/chat"),
    win("//?/C:/Users/Alice/Documents/Codex/2026-10-31/chat"),
    "/home/zqf", "/Users/Alice", win("C:/Users/Alice"), "/tmp", "/",
  ];
  const groups = groupProjectThreads(paths.map((cwd, i) => thread(String(i), cwd)), "recent", false);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].cwd, "");
  assert.equal(groups[0].threads.length, paths.length);
  assert.equal(projectCwdFor(thread("real", "/home/zqf/Documents/ChatGPT/CVPR")), "/home/zqf/Documents/ChatGPT/CVPR");
  assert.equal(projectCwdFor(thread("real", "/home/zqf/Documents/Codex/my-repo")), "/home/zqf/Documents/Codex/my-repo");
});

test("explicit membership overrides path inference without changing conversation cwd", () => {
  const assigned = thread("assigned", "/home/zqf/Documents/Codex/2026-10-31/real-project");
  const projectless = thread("none", "/some/custom/output");
  const membership = { projectlessThreadIds: ["none"], projectThreadIds: ["assigned"] };
  assert.equal(projectCwdFor(assigned, membership), assigned.cwd);
  assert.equal(projectCwdFor(projectless, membership), "");
  assert.equal(projectless.cwd, "/some/custom/output");
});
