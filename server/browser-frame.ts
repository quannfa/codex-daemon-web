type JsonRecord = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const compacted = value.map((entry) => {
      const next = compactValue(entry);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? compacted : value;
  }
  if (!isJsonObject(value)) return value;

  let next = value;
  if (
    value.type === "imageGeneration" &&
    typeof value.savedPath === "string" &&
    value.savedPath.trim() &&
    typeof value.result === "string"
  ) {
    next = { ...value };
    delete next.result;
  }

  let changed = next !== value;
  for (const [key, entry] of Object.entries(next)) {
    const compacted = compactValue(entry);
    if (compacted === entry) continue;
    if (!changed) {
      next = { ...next };
      changed = true;
    }
    next[key] = compacted;
  }
  return changed ? next : value;
}

/** Remove data that the browser can fetch from a local saved resource instead. */
export function compactBrowserPayload(value: unknown): unknown {
  return compactValue(value);
}

export function compactBrowserMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const compacted = compactBrowserPayload(parsed);
    return compacted === parsed ? text : JSON.stringify(compacted);
  } catch {
    return text;
  }
}
