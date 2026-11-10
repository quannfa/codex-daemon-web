import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import express, { type RequestHandler } from "express";

type Resource = { id: string; path: string };
export class ResourceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function within(root: string, path: string) {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep));
}
function permitted(path: string) {
  const parts = path.split(sep);
  return !parts.some((part,index) =>
    [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".git", ".config", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".dockercfg"].includes(part) ||
    (part === ".codex" && !(parts[index+1] === ".chatgpt-projects" && parts[index+2])) ||
    /^\.env(?:\.|$)/.test(part) || /^(?:id_rsa|id_ed25519)(?:\.|$)/.test(part)
  ) && !/\.(?:key|p12|pfx|pem)$/i.test(path) && !["/proc", "/sys", "/dev"].some(root => within(root,path));
}
export function resourceType(path: string) {
  const ext = extname(path).toLowerCase();
  const images: Record<string,string> = {".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".webp":"image/webp", ".avif":"image/avif"};
  if (images[ext]) return {kind:"image", mime:images[ext]};
  if (ext === ".pdf") return {kind:"pdf", mime:"application/pdf"};
  if (ext === ".md" || ext === ".markdown") return {kind:"markdown", mime:"text/plain; charset=utf-8"};
  if (ext === ".svg") return {kind:"svg", mime:"text/plain; charset=utf-8"};
  if ([".html", ".htm"].includes(ext)) return {kind:"html", mime:"text/plain; charset=utf-8"};
  if ([".txt", ".json", ".csv", ".tsv", ".ts", ".tsx", ".js", ".jsx", ".py", ".log", ".yaml", ".yml", ".css", ".sh", ".xml", ".toml", ".rs", ".go", ".c", ".h", ".cpp"].includes(ext)) return {kind:"text", mime:"text/plain; charset=utf-8"};
  return {kind:"binary", mime:"application/octet-stream"};
}
export class ResourceStore {
  private entries = new Map<string,Resource>();
  private saving: Promise<void> = Promise.resolve();
  constructor(private readonly registryPath: string, private readonly localFiles = true) {}
  private async assertPermitted(path: string) {
    if (!this.localFiles) throw new ResourceError(400,"Local resource preview requires a local daemon. Remote host resources are not connected yet.");
    let stateDirectory = resolve(dirname(this.registryPath));
    try { stateDirectory = await realpath(stateDirectory); } catch { /* Created on first registration. */ }
    if (!permitted(path) || within(stateDirectory, path) || within(resolve(dirname(this.registryPath)), path))
      throw new ResourceError(403,"This file is not available through resource preview.");
  }
  async initialize() {
    try {
      const entries: Resource[] = JSON.parse(await readFile(this.registryPath,"utf8"));
      for (const entry of entries) if (/^[a-f0-9]{32}$/.test(entry.id) && isAbsolute(entry.path) ) this.entries.set(entry.id, {id:entry.id,path:entry.path});
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  private async check(entry: Resource) {
    await this.assertPermitted(entry.path);
    const path = await realpath(entry.path);
    await this.assertPermitted(path);
    // Open the checked file, then verify the actual descriptor target as well.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actual = await realpath(`/proc/self/fd/${file.fd}`);
      await this.assertPermitted(actual);
      const stat = await file.stat();
      if (!stat.isFile()) throw new ResourceError(400,"This resource is not a regular file.");
      return {file, stat};
    } catch (e) { await file.close(); throw e; }
  }
  get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new ResourceError(404,"Resource not found. Reopen its original file link.");
    return entry;
  }
  async register(input: {path: string; threadId?: string; baseResourceId?: string}) {
    if (!input.path || input.path.length > 8192 || input.path.includes("\0")) throw new ResourceError(400,"Invalid resource path.");
    const parent = input.baseResourceId ? this.get(input.baseResourceId) : undefined;
    if (!parent && !isAbsolute(input.path)) throw new ResourceError(400,"An absolute resource path is required.");
    const path = parent ? resolve(dirname(parent.path), input.path) : resolve(input.path);
    await this.assertPermitted(path);
    // Keep existing IDs (including the old root-scoped registry) valid.
    const entry = [...this.entries.values()].find(value => value.path === path) || {
      id:createHash("sha256").update("local-file\0" + path).digest("hex").slice(0,32), path,
    };
    const checked = await this.check(entry); await checked.file.close();
    if (!this.entries.has(entry.id)) {
      if (this.entries.size >= 20000) throw new ResourceError(409,"Resource registry is full.");
      this.entries.set(entry.id, entry);
      this.saving = this.saving.catch(() => {}).then(async () => {
        await mkdir(dirname(this.registryPath), {recursive:true,mode:0o700});
        const temp = this.registryPath + ".tmp";
        await writeFile(temp, JSON.stringify([...this.entries.values()]), {mode:0o600});
        await rename(temp, this.registryPath);
      });
      await this.saving;
    }
    const {file,stat} = await this.check(entry); await file.close();
    return {...entry, name:basename(path), size:stat.size, ...resourceType(path)};
  }
  async open(id: string) { const entry = this.get(id); return {entry, ...await this.check(entry)}; }
}
function failure(error: unknown, response: express.Response) {
  if (response.headersSent) { response.destroy(); return; }
  const code = (error as NodeJS.ErrnoException).code;
  const status = error instanceof ResourceError ? error.status : code === "ENOENT" || code === "ENOTDIR" ? 404 : code === "EACCES" || code === "EPERM" ? 403 : 500;
  response.status(status).json({error:error instanceof ResourceError ? error.message : status === 404 ? "The original file no longer exists." : status === 403 ? "The WebUI account cannot read this file." : "Could not read this resource."});
}
export function mountResources(app: express.Express, store: ResourceStore, auth: RequestHandler, origin: RequestHandler, basePath = "/api/resources") {
  app.post(basePath, auth, origin, async (request, response) => {
    try {
      const {path,threadId,baseResourceId} = request.body ?? {};
      if (typeof path !== "string" || (threadId !== undefined && typeof threadId !== "string") || (baseResourceId !== undefined && typeof baseResourceId !== "string")) throw new ResourceError(400,"Invalid resource request.");
      response.setHeader("Cache-Control","no-store");
      const info = await store.register({path,threadId,baseResourceId});
      response.locals.checkResourceAccess?.();
      response.json(info);
    } catch(e) { failure(e,response); }
  });
  app.get(basePath + "/:id/:name", auth, async (request, response) => {
    let file: Awaited<ReturnType<ResourceStore["open"]>>["file"] | undefined;
    try {
      const opened = await store.open(String(request.params.id)); file = opened.file;
      response.locals.checkResourceAccess?.();
      const {entry,stat} = opened;
      const type = resourceType(entry.path);
      const download = request.query.download === "1" || type.kind === "binary";
      response.setHeader("Content-Type",type.mime);
      response.setHeader("Content-Disposition",`${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(basename(entry.path)).replace(/['()*]/g,c=>"%"+c.charCodeAt(0).toString(16))}`);
      response.setHeader("Cache-Control",response.locals.checkResourceAccess ? "no-store" : "private, no-cache");
      response.setHeader("X-Content-Type-Options","nosniff");
      response.setHeader("X-Frame-Options","SAMEORIGIN");
      response.setHeader("Content-Security-Policy","default-src 'none'; frame-ancestors 'self'");
      response.setHeader("Cross-Origin-Resource-Policy","same-origin");
      response.setHeader("Accept-Ranges","bytes");
      const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
      response.setHeader("ETag",etag);
      if (request.headers["if-none-match"] === etag && !request.headers.range) {response.status(304).end();return;}
      let start = 0, end = stat.size-1;
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!match || (!match[1] && !match[2])) throw new ResourceError(416,"Invalid byte range.");
        if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]),end) : end; }
        else start = Math.max(0,stat.size-Number(match[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {response.setHeader("Content-Range",`bytes */${stat.size}`);throw new ResourceError(416,"Invalid byte range.");}
        response.status(206).setHeader("Content-Range",`bytes ${start}-${end}/${stat.size}`);
      }
      response.setHeader("Content-Length",Math.max(0,end-start+1));
      if (request.method === "HEAD" || stat.size === 0) { response.end(); return; }
      await pipeline(file.createReadStream({start,end,autoClose:false}),response);
    } catch(e) {failure(e,response);} finally {await file?.close().catch(()=>{});}
  });
}
