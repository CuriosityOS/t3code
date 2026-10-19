import { assert, describe, it } from "@effect/vitest";

import {
  mergePiBackgroundTasks,
  parsePiBackgroundTasks,
  piBackgroundTasksSource,
  piBackgroundTasksEqual,
  piBackgroundTasksHoldSession,
} from "./backgroundTasks.ts";

describe("parsePiBackgroundTasks", () => {
  it("reads a cleared or empty status as no work", () => {
    assert.deepEqual(parsePiBackgroundTasks(undefined), []);
    assert.deepEqual(parsePiBackgroundTasks("  "), []);
    assert.deepEqual(parsePiBackgroundTasks("[]"), []);
  });

  it("refuses text that is not a task list", () => {
    assert.isNull(parsePiBackgroundTasks("2 background terminals running"));
    assert.isNull(parsePiBackgroundTasks('{"taskId":"a"}'));
  });

  it("keeps valid entries, defaults the kind, and drops duplicates and junk", () => {
    const tasks = parsePiBackgroundTasks(
      JSON.stringify([
        { taskId: " build ", description: " pnpm build " },
        { taskId: "build", kind: "monitor" },
        { taskId: "watch", kind: "monitor", description: "" },
        { taskId: "dev", kind: "command" },
        { taskId: "odd", kind: "subagent" },
        { taskId: "" },
        { description: "no id" },
        null,
        "build",
      ]),
    );
    assert.deepEqual(tasks, [
      { taskId: "build", kind: "background_task", description: "pnpm build" },
      { taskId: "watch", kind: "monitor" },
      { taskId: "dev", kind: "command" },
      { taskId: "odd", kind: "background_task" },
    ]);
  });

  it("bounds the list and each description", () => {
    const tasks = parsePiBackgroundTasks(
      JSON.stringify(
        Array.from({ length: 80 }, (_, index) => ({
          taskId: `task-${index}`,
          description: "x".repeat(500),
        })),
      ),
    );
    assert.strictEqual(tasks?.length, 50);
    assert.strictEqual(tasks?.[0]?.description?.length, 200);
  });
});

describe("pi background task rosters", () => {
  it("compares rosters by id, kind and description in order", () => {
    const build = { taskId: "build", kind: "background_task" as const };
    assert.isTrue(piBackgroundTasksEqual([build], [{ ...build }]));
    assert.isFalse(piBackgroundTasksEqual([build], [{ ...build, kind: "monitor" }]));
    assert.isFalse(piBackgroundTasksEqual([build], [{ ...build, description: "pnpm build" }]));
    assert.isFalse(piBackgroundTasksEqual([build], []));
  });

  it("pins the session only for work the agent waits on", () => {
    assert.isFalse(piBackgroundTasksHoldSession([]));
    assert.isFalse(
      piBackgroundTasksHoldSession(
        parsePiBackgroundTasks('[{"taskId":"dev","kind":"command"}]') ?? [],
      ),
    );
    assert.isTrue(
      piBackgroundTasksHoldSession(parsePiBackgroundTasks('[{"taskId":"build"}]') ?? []),
    );
    assert.isTrue(
      piBackgroundTasksHoldSession(
        parsePiBackgroundTasks('[{"taskId":"watch","kind":"monitor"}]') ?? [],
      ),
    );
  });
});

describe("pi background task sources", () => {
  it("reads the source from a background-task status key", () => {
    assert.strictEqual(piBackgroundTasksSource("t3:background-tasks"), "");
    assert.strictEqual(piBackgroundTasksSource("t3:background-tasks:terminals"), "terminals");
    assert.isNull(piBackgroundTasksSource("t3:background-tasksx"));
    assert.isNull(piBackgroundTasksSource("subagents"));
    assert.isNull(piBackgroundTasksSource(undefined));
  });

  it("merges every source's tasks under source-scoped ids", () => {
    const merged = mergePiBackgroundTasks(
      new Map([
        ["terminals", parsePiBackgroundTasks('[{"taskId":"1","description":"build"}]') ?? []],
        ["subagents", parsePiBackgroundTasks('[{"taskId":"1","kind":"monitor"}]') ?? []],
        ["", parsePiBackgroundTasks('[{"taskId":"plain"}]') ?? []],
      ]),
    );
    assert.deepEqual(merged, [
      { taskId: "terminals:1", kind: "background_task", description: "build" },
      { taskId: "subagents:1", kind: "monitor" },
      { taskId: "plain", kind: "background_task" },
    ]);
  });
});
