import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionUploads } from "../server/session-uploads";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOZkAAAAASUVORK5CYII=",
  "base64",
);

test("session uploads produce official local inputs and isolate sessions", async (t) => {
  const directory = await mkdtemp(join("/tmp", "codex-session-upload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const uploads = new SessionUploads(
    join(directory, "state", "uploads.json"),
    join(directory, "files"),
  );
  await uploads.initialize();

  const session = "session-one";
  const otherSession = "session-two";
  const imageId = randomUUID();
  const fileId = randomUUID();
  const pdfId = randomUUID();
  const image = await uploads.put(session, imageId, "photo.png", png);
  const file = await uploads.put(
    session,
    fileId,
    "notes.txt",
    Buffer.from("hello attachment"),
  );
  const pdf = await uploads.put(
    session,
    pdfId,
    "paper.pdf",
    Buffer.from("%PDF-1.7\n% test document"),
  );

  assert.equal(image.kind, "image");
  assert.equal(image.input[0].type, "text");
  assert.equal(image.input[1].type, "localImage");
  assert.equal(file.kind, "file");
  assert.equal(file.input.length, 1);
  assert.match(String(file.input[0].text), /notes\.txt/);
  assert.equal(pdf.kind, "file");
  assert.equal(pdf.mime, "application/pdf");
  await assert.rejects(
    uploads.retain(otherSession, [imageId]),
    (error: unknown) => (error as { status?: number }).status === 404,
  );

  await uploads.retain(session, [imageId, fileId, pdfId]);
  await assert.rejects(
    uploads.remove(session, imageId),
    (error: unknown) => (error as { status?: number }).status === 409,
  );

  const registry = JSON.parse(
    await readFile(join(directory, "state", "uploads.json"), "utf8"),
  ) as Array<{ path: string; retained: boolean }>;
  assert.equal(registry.length, 3);
  assert.ok(registry.every((entry) => entry.retained));
  assert.deepEqual(await readFile(registry[0].path), png);
  assert.equal((await stat(registry[0].path)).mode & 0o777, 0o600);
  assert.equal((await readdir(join(directory, "files"))).length, 1);

  const restarted = new SessionUploads(
    join(directory, "state", "uploads.json"),
    join(directory, "files"),
  );
  await restarted.initialize();
  const same = await restarted.put(session, imageId, "photo.png", png);
  assert.deepEqual(same.input, image.input);

  const draftId = randomUUID();
  await restarted.put(session, draftId, "draft.txt", Buffer.from("draft"));
  const draftState = JSON.parse(
    await readFile(join(directory, "state", "uploads.json"), "utf8"),
  ) as Array<Record<string, unknown>>;
  for (const entry of draftState) {
    if (entry.id === draftId) entry.createdAt = Date.now() - 2 * 86400_000;
  }
  await writeFile(
    join(directory, "state", "uploads.json"),
    JSON.stringify(draftState),
  );
  const pruned = new SessionUploads(
    join(directory, "state", "uploads.json"),
    join(directory, "files"),
  );
  await pruned.initialize();
  await assert.rejects(
    stat(String(draftState.find((entry) => entry.id === draftId)?.path)),
    { code: "ENOENT" },
  );
});
