export type ItemTimestamps = { startedAtMs?: unknown; completedAtMs?: unknown };

export function validTimestampMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8.64e15
    ? value : null;
}

// A message keeps its start time while streaming and after completion/reload.
// Completion is a fallback for older records that only captured the end event.
export function messageTimestampMs(value: ItemTimestamps): number | null {
  return validTimestampMs(value.startedAtMs) ?? validTimestampMs(value.completedAtMs);
}

// Started/completed notifications contain different fields; an omitted field
// must not erase a timestamp already received from another event or history.
export function mergeItemTimestamps(incoming: ItemTimestamps, previous?: ItemTimestamps) {
  return {
    startedAtMs: validTimestampMs(incoming.startedAtMs) ?? validTimestampMs(previous?.startedAtMs),
    completedAtMs: validTimestampMs(incoming.completedAtMs) ?? validTimestampMs(previous?.completedAtMs),
  };
}

export function formatMessageTime(value: ItemTimestamps): { dateTime: string; label: string; title: string } | null {
  const ms = messageTimestampMs(value);
  if (ms === null) return null;
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    dateTime: date.toISOString(),
    label: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    title: new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date),
  };
}
