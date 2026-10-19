import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { formatPiProtocolLogPayload, makePiRpcProtocolLogger } from "./nativeLogging.ts";
import type { PiRpcFrame } from "./rpc.ts";

const THREAD_ID = ThreadId.make("thread-pi-log");

function capturingLogger() {
  const writes: Array<{ readonly event: unknown; readonly threadId: ThreadId | null }> = [];
  const logger: ProviderEventLoggers.EventNdjsonLogger = {
    filePath: "/logs/events.log",
    write: (event, threadId) => Effect.sync(() => void writes.push({ event, threadId })),
    close: () => Effect.void,
  };
  return { logger, writes };
}

const makeLogger = (nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined) =>
  makePiRpcProtocolLogger({
    nativeEventLogger,
    providerInstanceId: ProviderInstanceId.make("aside-code"),
    providerSessionId: ProviderSessionId.make("provider-session-pi-log"),
    threadId: THREAD_ID,
  });

describe("Pi native protocol logging", () => {
  it("is absent when the server has no provider event log", () => {
    assert.isUndefined(makeLogger(undefined));
  });

  it.effect("writes summarized frames to the thread's native log", () =>
    Effect.gen(function* () {
      const { logger, writes } = capturingLogger();
      const log = makeLogger(logger)!;
      yield* log({
        direction: "outgoing",
        record: {
          type: "prompt",
          id: "t3-3",
          message: "deploy with token sk-live-123",
          streamingBehavior: "steer",
        },
      });
      yield* log({
        direction: "incoming",
        record: {
          type: "response",
          id: "t3-3",
          command: "prompt",
          success: false,
          error: "Agent is already processing sk-live-123",
        },
      });

      assert.lengthOf(writes, 2);
      assert.isTrue(writes.every((write) => write.threadId === THREAD_ID));
      assert.deepEqual(writes[0]!.event, {
        provider: "pi",
        protocol: "pi.rpc-jsonl",
        kind: "protocol",
        providerInstanceId: "aside-code",
        providerSessionId: "provider-session-pi-log",
        event: {
          direction: "outgoing",
          method: "prompt",
          id: "t3-3",
          streamingBehavior: "steer",
          payload: { valueType: "object", fieldCount: 4 },
        },
      });
      assert.deepInclude(writes[1]!.event as object, {
        event: {
          direction: "incoming",
          method: "response",
          command: "prompt",
          id: "t3-3",
          success: false,
          error: { valueType: "string", byteLength: 39 },
          payload: { valueType: "object", fieldCount: 5 },
        },
      });
      assert.notInclude(JSON.stringify(writes), "sk-live-123");
    }),
  );

  it.effect("skips streaming deltas and tool progress", () =>
    Effect.gen(function* () {
      const { logger, writes } = capturingLogger();
      const log = makeLogger(logger)!;
      const frames: ReadonlyArray<PiRpcFrame> = [
        {
          direction: "incoming",
          record: {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
          },
        },
        {
          direction: "incoming",
          record: {
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm" },
          },
        },
        {
          direction: "incoming",
          record: { type: "message_update", message: { role: "assistant" } },
        },
        {
          direction: "incoming",
          record: {
            type: "tool_execution_update",
            toolCallId: "call_1",
            toolName: "bash",
            partialResult: { content: [{ type: "text", text: "line" }] },
          },
        },
        {
          direction: "incoming",
          record: {
            type: "message_update",
            assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" },
          },
        },
      ];
      yield* Effect.forEach(frames, log, { discard: true });

      assert.lengthOf(writes, 1);
      assert.deepInclude(writes[0]!.event as object, {
        event: {
          direction: "incoming",
          method: "message_update",
          assistantEvent: "text_end",
          payload: { valueType: "object", fieldCount: 2 },
        },
      });
    }),
  );

  it("keeps only identifiers and shape from event frames", () => {
    assert.deepEqual(
      formatPiProtocolLogPayload({
        direction: "incoming",
        record: {
          type: "extension_ui_request",
          id: "00000000-0000-4000-8000-000000000001",
          method: "notify",
          message: "t3-code MCP unavailable: T3_MCP_BEARER_TOKEN is missing.",
          notifyType: "warning",
        },
      }),
      {
        direction: "incoming",
        method: "extension_ui_request",
        id: "00000000-0000-4000-8000-000000000001",
        uiMethod: "notify",
        notifyType: "warning",
        payload: { valueType: "object", fieldCount: 5 },
      },
    );
    assert.deepEqual(
      formatPiProtocolLogPayload({
        direction: "incoming",
        record: {
          type: "tool_execution_end",
          toolCallId: "toolu_01ABC",
          toolName: "bash",
          isError: true,
          result: { content: [{ type: "text", text: "rm -rf output" }] },
        },
      }),
      {
        direction: "incoming",
        method: "tool_execution_end",
        toolName: "bash",
        toolCallId: "toolu_01ABC",
        isError: true,
        payload: { valueType: "object", fieldCount: 5 },
      },
    );
    assert.deepEqual(
      formatPiProtocolLogPayload({
        direction: "incoming",
        record: {
          type: "message_end",
          id: "an id with spaces",
          toolName: "Name with spaces",
          message: { role: "assistant", stopReason: "error", errorMessage: "quota for key-123" },
        },
      }),
      {
        direction: "incoming",
        method: "message_end",
        id: "unknown",
        toolName: "unknown",
        role: "assistant",
        stopReason: "error",
        payload: { valueType: "object", fieldCount: 4 },
      },
    );
  });
});
