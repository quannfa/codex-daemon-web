export type GoalWaitPhase = "pausing" | "waiting" | "resuming";

export type GoalWaitStatus = {
  waitId: string;
  threadId: string;
  until: string;
  reason: string;
  resumeMode: "goal" | "queue";
  phase: GoalWaitPhase;
};

export type GoalWaitDisplayMode = "preparing" | "waiting" | "resuming";

export function isGoalWaitStatus(value: unknown): value is GoalWaitStatus {
  if (!value || typeof value !== "object") return false;
  const wait = value as Record<string, unknown>;
  return (
    typeof wait.waitId === "string" &&
    typeof wait.threadId === "string" &&
    typeof wait.until === "string" &&
    Number.isFinite(Date.parse(wait.until)) &&
    typeof wait.reason === "string" &&
    (wait.resumeMode === "goal" || wait.resumeMode === "queue") &&
    (wait.phase === "pausing" ||
      wait.phase === "waiting" ||
      wait.phase === "resuming")
  );
}

export function formatWaitCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(
    0,
    Math.ceil(Number.isFinite(milliseconds) ? milliseconds / 1_000 : 0),
  );
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function goalWaitDisplayMode(
  wait: GoalWaitStatus,
  serverNow: number,
): GoalWaitDisplayMode {
  if (wait.phase === "pausing") return "preparing";
  if (wait.phase === "resuming" || Date.parse(wait.until) <= serverNow)
    return "resuming";
  return "waiting";
}
