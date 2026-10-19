import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  structuralProtocolMethod,
  summarizeNativeProtocolPayload,
} from "@t3tools/provider-core/server/nativeProtocolLogging";
import { piRecordField as recordField, type PiRpcFrame, type PiRpcRecord } from "./rpc.ts";

const PI_PROVIDER = ProviderDriverKind.make("pi");
export const PI_RPC_PROTOCOL = "pi.rpc-jsonl";

/**
 * Streaming progress repeats on every token or output chunk; the surrounding
 * start/end frames already mark the timeline.
 */
const TRANSIENT_PI_EVENT_TYPES = new Set(["tool_execution_update"]);

function isTransientPiFrame(record: PiRpcRecord): boolean {
  const type = record["type"];
  if (type === "message_update") {
    const assistantEventType = recordField(record["assistantMessageEvent"], "type");
    return typeof assistantEventType !== "string" || assistantEventType.endsWith("_delta");
  }
  return typeof type === "string" && TRANSIENT_PI_EVENT_TYPES.has(type);
}

/** Opaque correlation ids (`t3-4`, UUIDs, tool call ids); anything else is withheld. */
function structuralId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : "unknown";
}

function structuralName(value: unknown): string | undefined {
  return typeof value === "string" ? structuralProtocolMethod(value) : undefined;
}

function defined(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | boolean>> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string | boolean] =>
        typeof entry[1] === "string" || typeof entry[1] === "boolean",
    ),
  );
}

/**
 * Pi frames carry prompts, tool arguments and output, extension dialog values,
 * and model text, so only identifiers and shape survive into the log.
 */
export function formatPiProtocolLogPayload(frame: PiRpcFrame): Readonly<Record<string, unknown>> {
  const { record } = frame;
  const message = record["message"];
  const error = record["error"];
  return {
    direction: frame.direction,
    method: structuralName(record["type"]) ?? "unknown",
    ...defined({
      command: structuralName(record["command"]),
      id: structuralId(record["id"]),
      success: typeof record["success"] === "boolean" ? record["success"] : undefined,
      uiMethod: structuralName(record["method"]),
      notifyType: structuralName(record["notifyType"]),
      toolName: structuralName(record["toolName"]),
      toolCallId: structuralId(record["toolCallId"]),
      isError: typeof record["isError"] === "boolean" ? record["isError"] : undefined,
      assistantEvent: structuralName(recordField(record["assistantMessageEvent"], "type")),
      role: structuralName(recordField(message, "role")),
      stopReason: structuralName(recordField(message, "stopReason")),
      streamingBehavior: structuralName(record["streamingBehavior"]),
    }),
    ...(error === undefined ? {} : { error: summarizeNativeProtocolPayload(error) }),
    payload: summarizeNativeProtocolPayload(record),
  };
}

/**
 * Per-thread native protocol log for Pi's RPC transport, written to the shared
 * provider event log store like the Claude and OpenCode adapters. Undefined
 * when the server runs without that store, so the transport skips the hook.
 */
export function makePiRpcProtocolLogger(input: {
  readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
}): ((frame: PiRpcFrame) => Effect.Effect<void>) | undefined {
  const { nativeEventLogger } = input;
  if (nativeEventLogger === undefined) return undefined;
  return (frame) => {
    if (isTransientPiFrame(frame.record)) return Effect.void;
    return nativeEventLogger
      .write(
        {
          provider: PI_PROVIDER,
          protocol: PI_RPC_PROTOCOL,
          kind: "protocol",
          providerInstanceId: input.providerInstanceId,
          providerSessionId: input.providerSessionId,
          event: formatPiProtocolLogPayload(frame),
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
  };
}
