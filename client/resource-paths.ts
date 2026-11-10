export function localReferencePath(href: string, cwd: string): string | null {
  let path = href.trim();
  if (!path || path.startsWith("#") || path.startsWith("//")) return null;
  try {
    if (/^file:\/\//i.test(path)) {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
    } else {
      if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
      path = decodeURIComponent(path.split("#")[0].split("?")[0]);
    }
  } catch { return null; }
  path = path.replace(/:\d+(?::\d+)?$/, "");
  if (!path || path.includes("\0") || path.includes("\\")) return null;
  if (!path.startsWith("/")) { if (!cwd.startsWith("/")) return null; path = cwd + "/" + path; }
  const parts: string[] = [];
  for (const part of path.split("/")) { if(part === "..") parts.pop(); else if(part && part !== ".") parts.push(part); }
  return "/" + parts.join("/");
}
export function safeMarkdownUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return "";
  if (/^codex:\/\/threads\/[a-f0-9-]{20,}$/i.test(trimmed)) return trimmed;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(trimmed)) return trimmed;
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try { const url = new URL(trimmed); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
  }
  return trimmed.startsWith("//") || trimmed.includes("\\") ? "" : trimmed;
}
