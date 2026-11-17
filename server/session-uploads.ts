import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MAX_SHARED_ATTACHMENTS,
  MAX_SHARED_UPLOAD_BYTES,
  detectUploadImageMime,
  detectUploadMime,
  normalizeUploadFilename,
  publicUpload,
  uploadIdPattern,
  uploadInput,
  type UploadKind,
} from "./shared-uploads.js";
import { ShareError } from "./conversation-shares.js";

type SessionUpload = {
  id: string;
  scope: string;
  name: string;
  path: string;
  size: number;
  kind: UploadKind;
  mime: string;
  digest: string;
  createdAt: number;
  retained: boolean;
};

export class SessionUploadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SessionUploadError";
  }
}
export function sessionUploadScope(session: string): string {
  return createHash("sha256")
    .update("codex-session-uploads\0" + session)
    .digest("hex");
}

export function sessionUploadRoot(root: string, session: string): string {
  return join(root, sessionUploadScope(session));
}

function validScope(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function publicSessionUpload(entry: SessionUpload) {
  return {
    ...publicUpload(entry),
    input: uploadInput(entry),
    runtimeWorkspaceRoot: join(entry.path, "..", ".."),
  };
}

export class SessionUploads {
  private entries: SessionUpload[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly registryPath: string,
    private readonly root: string,
    readonly localFiles = true,
  ) {}

  runtimeWorkspaceRoot(session: string): string {
    return sessionUploadRoot(this.root, session);
  }

  async initialize(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.registryPath, "utf8"));
      if (
        !Array.isArray(raw) ||
        raw.some((value) => {
          const entry = value as Partial<SessionUpload>;
          const size = entry.size;
          if (
            !entry ||
            typeof entry.id !== "string" ||
            !uploadIdPattern.test(entry.id) ||
            !validScope(entry.scope) ||
            typeof entry.name !== "string" ||
            typeof size !== "number" ||
            !Number.isSafeInteger(size) ||
            size < 0
          )
            return true;
          return (
            entry.name !== normalizeUploadFilename(entry.name) ||
            entry.path !== join(this.root, entry.scope, entry.id, entry.name) ||
            !["image", "file"].includes(String(entry.kind)) ||
            typeof entry.mime !== "string" ||
            !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(entry.mime) ||
            typeof entry.digest !== "string" ||
            !/^[a-f0-9]{64}$/.test(entry.digest) ||
            typeof entry.createdAt !== "number" ||
            !Number.isSafeInteger(entry.createdAt) ||
            typeof entry.retained !== "boolean"
          );
        })
      ) {
        throw new Error("Invalid session upload registry");
      }
      this.entries = raw as SessionUpload[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.prune();
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async persist(entries: SessionUpload[]): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
    await rename(temporary, this.registryPath);
    this.entries = entries;
  }

  private find(scope: string, id: string): SessionUpload {
    const entry = this.entries.find((value) => value.scope === scope && value.id === id);
    if (!entry)
      throw new SessionUploadError(404, "Attachment not found. Upload it again.");
    return entry;
  }

  async put(
    session: string,
    id: string,
    name: string,
    data: Buffer,
  ): Promise<ReturnType<typeof publicSessionUpload>> {
    if (!this.localFiles)
      throw new SessionUploadError(400, "File uploads require a local daemon.");
    if (!uploadIdPattern.test(id) || !Buffer.isBuffer(data))
      throw new SessionUploadError(400, "Invalid upload.");
    if (data.length > MAX_SHARED_UPLOAD_BYTES)
      throw new SessionUploadError(413, "Each file must be 32 MB or smaller.");
    const scope = sessionUploadScope(session);
    let safeName: string;
    try {
      safeName = normalizeUploadFilename(name);
    } catch (error) {
      if (error instanceof ShareError)
        throw new SessionUploadError(error.status, error.message);
      throw error;
    }
    const digest = createHash("sha256").update(data).digest("hex");
    const normalizedId = id.toLowerCase();
    return this.exclusive(async () => {
      const prior = this.entries.find(
        (entry) => entry.scope === scope && entry.id === normalizedId,
      );
      if (prior) {
        if (prior.digest !== digest || prior.name !== safeName)
          throw new SessionUploadError(
            409,
            "This upload ID was already used for another file.",
          );
        return publicSessionUpload(prior);
      }
      const parent = join(this.root, scope);
      const folder = join(parent, normalizedId);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await mkdir(folder, { mode: 0o700 });
      const imageMime = detectUploadImageMime(data, safeName);
      const mime = detectUploadMime(data, safeName);
      const entry: SessionUpload = {
        id: normalizedId,
        scope,
        name: safeName,
        path: join(folder, safeName),
        size: data.length,
        kind: imageMime ? "image" : "file",
        mime,
        digest,
        createdAt: Date.now(),
        retained: false,
      };
      try {
        await writeFile(entry.path, data, { flag: "wx", mode: 0o600 });
        await this.persist([...this.entries, entry]);
        return publicSessionUpload(entry);
      } catch (error) {
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async remove(session: string, id: string): Promise<void> {
    const scope = sessionUploadScope(session);
    return this.exclusive(async () => {
      const entry = this.find(scope, id.toLowerCase());
      if (entry.retained)
        throw new SessionUploadError(
          409,
          "Attachments already submitted to a conversation are kept with its history.",
        );
      await this.persist(this.entries.filter((value) => value !== entry));
      await rm(dirname(entry.path), { recursive: true, force: true });
    });
  }

  async retain(session: string, ids: string[]): Promise<void> {
    if (ids.length > MAX_SHARED_ATTACHMENTS)
      throw new SessionUploadError(400, "A message can contain at most 10 attachments.");
    const normalized = ids.map((id) => id.toLowerCase());
    if (
      normalized.some((id) => !uploadIdPattern.test(id)) ||
      new Set(normalized).size !== normalized.length
    ) {
      throw new SessionUploadError(400, "Invalid attachment IDs.");
    }
    const scope = sessionUploadScope(session);
    return this.exclusive(async () => {
      const entries = normalized.map((id) => this.find(scope, id));
      for (const entry of entries) {
        const details = await stat(entry.path).catch(() => null);
        if (!details?.isFile())
          throw new SessionUploadError(
            410,
            "An attachment is no longer available. Upload it again.",
          );
      }
      if (!entries.some((entry) => !entry.retained)) return;
      await this.persist(
        this.entries.map((entry) =>
          entries.includes(entry) ? { ...entry, retained: true } : entry,
        ),
      );
    });
  }

  async prune(): Promise<void> {
    return this.exclusive(async () => {
      const old = this.entries.filter(
        (entry) => !entry.retained && entry.createdAt < Date.now() - 86400_000,
      );
      if (!old.length) return;
      await this.persist(this.entries.filter((entry) => !old.includes(entry)));
      for (const entry of old)
        await rm(dirname(entry.path), { recursive: true, force: true });
    });
  }
}
