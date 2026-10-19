import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

/**
 * Pi has no RPC event for background work, so extensions report it through
 * `ctx.ui.setStatus("t3:background-tasks:<source>", json)`, one key per
 * extension so their reports do not replace each other (a bare
 * `t3:background-tasks` is the empty source). The text is a JSON array of
 * `{ taskId, kind?, description? }` for that source's work still running in
 * the session; an empty array or a cleared status means none. `kind` is
 * `background_task` (default) or `monitor` for work the agent will be woken
 * by, and `command` for work it does not wait on, such as a dev server.
 */
export const PI_BACKGROUND_TASKS_STATUS_KEY = "t3:background-tasks";

/** The reporting source for a background-task status key, else null. */
export function piBackgroundTasksSource(statusKey: unknown): string | null {
  if (statusKey === PI_BACKGROUND_TASKS_STATUS_KEY) return "";
  if (typeof statusKey !== "string" || !statusKey.startsWith(`${PI_BACKGROUND_TASKS_STATUS_KEY}:`))
    return null;
  return statusKey.slice(PI_BACKGROUND_TASKS_STATUS_KEY.length + 1);
}

const MAX_TASKS = 50;
const MAX_DESCRIPTION_LENGTH = 200;
type PiTaskKind = "background_task" | "monitor" | "command";
const isPiTaskKind = (value: unknown): value is PiTaskKind =>
  value === "background_task" || value === "monitor" || value === "command";

/** The reported tasks, or null when the status text is not a task list. */
export function parsePiBackgroundTasks(
  statusText: string | undefined,
): ReadonlyArray<OrchestrationV2PendingBackgroundTask> | null {
  if (statusText === undefined || statusText.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(statusText);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const tasks: OrchestrationV2PendingBackgroundTask[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rawId = Reflect.get(entry, "taskId");
    const taskId = typeof rawId === "string" ? rawId.trim() : "";
    if (taskId.length === 0 || seen.has(taskId)) continue;
    seen.add(taskId);
    const rawKind = Reflect.get(entry, "kind");
    const kind: PiTaskKind = isPiTaskKind(rawKind) ? rawKind : "background_task";
    const rawDescription = Reflect.get(entry, "description");
    const description =
      typeof rawDescription === "string"
        ? rawDescription.trim().slice(0, MAX_DESCRIPTION_LENGTH).trim()
        : "";
    tasks.push({ taskId, kind, ...(description.length > 0 ? { description } : {}) });
    if (tasks.length === MAX_TASKS) break;
  }
  return tasks;
}

/** One roster from every source's report, in report order. */
export function mergePiBackgroundTasks(
  bySource: ReadonlyMap<string, ReadonlyArray<OrchestrationV2PendingBackgroundTask>>,
): ReadonlyArray<OrchestrationV2PendingBackgroundTask> {
  const merged: OrchestrationV2PendingBackgroundTask[] = [];
  const seen = new Set<string>();
  for (const [source, tasks] of bySource) {
    for (const task of tasks) {
      const taskId = source.length === 0 ? task.taskId : `${source}:${task.taskId}`;
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      merged.push({ ...task, taskId });
      if (merged.length === MAX_TASKS) return merged;
    }
  }
  return merged;
}

export function piBackgroundTasksEqual(
  left: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  right: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (task, index) =>
        task.taskId === right[index]?.taskId &&
        task.kind === right[index]?.kind &&
        task.description === right[index]?.description,
    )
  );
}

/** Work the agent waits on keeps its session loaded; a dev server does not. */
export const piBackgroundTasksHoldSession = backgroundWorkHoldsCompletion;
