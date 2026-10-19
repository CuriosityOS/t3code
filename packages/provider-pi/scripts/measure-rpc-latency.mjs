#!/usr/bin/env node
/**
 * Times Pi RPC round trips that the T3 adapter issues around a turn, so
 * adapter changes can be judged by real numbers instead of guesses.
 *
 *   node packages/provider-pi/scripts/measure-rpc-latency.mjs \
 *     --bin aside-code --extension /tmp/pi-t3-mcp-extension.ts \
 *     --session-kb 2000 [--prompt claude-code/claude-haiku-5-5]
 *
 * The process runs with `--no-session` in a temporary cwd. `switch_session`
 * targets a synthetic session file in that directory (`--session-kb` sizes
 * it), so no real session is read or written. `--extension` loads the T3
 * bridge (the file T3 materializes from `PI_T3_MCP_EXTENSION_SOURCE`) against
 * a local stub MCP server; `--mcp-latency-ms` delays each stub reply.
 * `--prompt <provider/model>` sends one real prompt on an empty session with
 * thinking off to time the first streamed delta; it is opt-in because it
 * costs money.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values: args } = NodeUtil.parseArgs({
  options: {
    bin: { type: "string", default: process.env.PI_BIN ?? "pi" },
    extension: { type: "string" },
    "mcp-latency-ms": { type: "string", default: "0" },
    "mcp-tools": { type: "string", default: "40" },
    "session-kb": { type: "string", default: "1000" },
    repeat: { type: "string", default: "5" },
    prompt: { type: "string" },
  },
});
const repeat = Number(args.repeat);
const mcpLatencyMs = Number(args["mcp-latency-ms"]);

const now = () => performance.now();
const ms = (value) => `${value.toFixed(1)}ms`;
const summarize = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return `median ${ms(sorted[Math.floor(sorted.length / 2)])} (min ${ms(sorted[0])}, max ${ms(sorted.at(-1))}, n=${sorted.length})`;
};

// Stub MCP server: enough of streamable HTTP for the bridge's initialize,
// notifications/initialized and tools/list.
const startStubMcp = () =>
  new Promise((resolve) => {
    const tools = Array.from({ length: Number(args["mcp-tools"]) }, (_, index) => ({
      name: `stub_tool_${index}`,
      description: `Stub tool ${index}`.repeat(8),
      inputSchema: {
        type: "object",
        properties: { value: { type: "string", description: "x".repeat(200) } },
      },
    }));
    const server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        setTimeout(() => {
          const message = JSON.parse(body);
          if (message.id === undefined) {
            response.writeHead(202).end();
            return;
          }
          const result =
            message.method === "initialize"
              ? {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "stub", version: "0" },
                }
              : message.method === "tools/list"
                ? { tools }
                : {};
          response
            .writeHead(200, {
              "content-type": "application/json",
              "mcp-session-id": "stub-session",
            })
            .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        }, mcpLatencyMs);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const writeSyntheticSession = (dir, targetKb) => {
  const file = NodePath.join(dir, "synthetic-session.jsonl");
  const iso = new Date().toISOString();
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: NodeCrypto.randomUUID(),
      timestamp: iso,
      cwd: dir,
    }),
  ];
  let parentId = null;
  let bytes = lines[0].length;
  let index = 0;
  while (bytes < targetKb * 1024) {
    const id = index.toString(16).padStart(8, "0");
    const user = index % 2 === 0;
    const text = `${user ? "Question" : "Answer"} ${index}: ${"lorem ipsum dolor sit amet ".repeat(user ? 8 : 80)}`;
    const message = user
      ? { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
      : {
          role: "assistant",
          content: [{ type: "text", text }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "synthetic",
          usage: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 20,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
    const line = JSON.stringify({ type: "message", id, parentId, timestamp: iso, message });
    lines.push(line);
    bytes += line.length + 1;
    parentId = id;
    index += 1;
  }
  NodeFS.writeFileSync(file, `${lines.join("\n")}\n`);
  return { file, bytes, entries: index };
};

const startPi = (cwd, env) => {
  const spawnedAt = now();
  const child = NodeChildProcess.spawn(
    args.bin,
    ["--mode", "rpc", "--no-session", ...(args.extension ? ["--extension", args.extension] : [])],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = record.type === "response" ? pending.get(record.id) : undefined;
      if (waiter !== undefined) {
        pending.delete(record.id);
        waiter({ record, at: now(), bytes: line.length });
        continue;
      }
      for (const listener of listeners) listener(record, now());
    }
  });
  child.stderr.resume();
  const request = (command) =>
    new Promise((resolve, reject) => {
      const id = `m-${nextId++}`;
      const sentAt = now();
      pending.set(id, ({ record, at, bytes }) =>
        record.success === false
          ? reject(new Error(`${command.type}: ${record.error}`))
          : resolve({ data: record.data, elapsed: at - sentAt, bytes }),
      );
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  return { child, spawnedAt, request, listeners };
};

const timeSerial = async (pi, command, count = repeat) => {
  const samples = [];
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    const result = await pi.request(command);
    samples.push(result.elapsed);
    bytes = result.bytes;
  }
  return { samples, bytes };
};

const main = async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-rpc-latency-"));
  const mcp = args.extension ? await startStubMcp() : undefined;
  const env = {
    ...process.env,
    ...(mcp === undefined
      ? {}
      : {
          T3_MCP_URL: `http://127.0.0.1:${mcp.address().port}/mcp`,
          T3_MCP_BEARER_TOKEN: "stub-token",
          T3_PI_RUNTIME_MODE: "full-access",
          T3_PI_MCP_EXTENSION_PATH: args.extension,
        }),
  };
  const pi = startPi(dir, env);
  try {
    // Pi attaches its stdin reader only after startup, so the first reply
    // marks the moment the process can serve T3's first request.
    await pi.request({ type: "get_state" });
    console.log(`startup (spawn -> first get_state reply): ${ms(now() - pi.spawnedAt)}`);

    const state = await timeSerial(pi, { type: "get_state" });
    console.log(`get_state: ${summarize(state.samples)}, ${state.bytes} bytes`);
    const models = await timeSerial(pi, { type: "get_available_models" });
    console.log(`get_available_models: ${summarize(models.samples)}, ${models.bytes} bytes`);

    const session = writeSyntheticSession(dir, Number(args["session-kb"]));
    console.log(
      `synthetic session: ${session.entries} entries, ${(session.bytes / 1024).toFixed(0)} KiB`,
    );
    const switches = await timeSerial(
      pi,
      { type: "switch_session", sessionPath: session.file },
      Math.min(repeat, 3),
    );
    console.log(`switch_session (same file each time): ${summarize(switches.samples)}`);

    const entries = await timeSerial(pi, { type: "get_entries" });
    console.log(
      `get_entries (full): ${summarize(entries.samples)}, ${(entries.bytes / 1024).toFixed(0)} KiB`,
    );
    const leafId = (await pi.request({ type: "get_entries" })).data.leafId;
    const since = await timeSerial(pi, { type: "get_entries", since: leafId });
    console.log(`get_entries (since leaf): ${summarize(since.samples)}, ${since.bytes} bytes`);

    const serial = [];
    const concurrent = [];
    for (let index = 0; index < repeat; index += 1) {
      let startedAt = now();
      await pi.request({ type: "get_state" });
      await pi.request({ type: "get_available_models" });
      await pi.request({ type: "get_entries" });
      serial.push(now() - startedAt);
      startedAt = now();
      await Promise.all([
        pi.request({ type: "get_state" }),
        pi.request({ type: "get_available_models" }),
        pi.request({ type: "get_entries" }),
      ]);
      concurrent.push(now() - startedAt);
    }
    console.log(`get_state+get_available_models+get_entries serial: ${summarize(serial)}`);
    console.log(`get_state+get_available_models+get_entries concurrent: ${summarize(concurrent)}`);

    const resumeOld = [];
    const resumeFast = [];
    for (let index = 0; index < Math.min(repeat, 3); index += 1) {
      // What registerThread did on every model/thinking change before.
      let startedAt = now();
      await pi.request({ type: "switch_session", sessionPath: session.file });
      await pi.request({ type: "get_state" });
      await pi.request({ type: "get_entries" });
      resumeOld.push(now() - startedAt);
      // Same-session fast path: one verification get_state.
      startedAt = now();
      await pi.request({ type: "get_state" });
      resumeFast.push(now() - startedAt);
    }
    console.log(`same-session resume, old (switch+state+entries): ${summarize(resumeOld)}`);
    console.log(`same-session resume, new (state only): ${summarize(resumeFast)}`);

    if (args.prompt !== undefined) {
      const [provider, ...rest] = args.prompt.split("/");
      // An empty context keeps the synthetic session out of the timing.
      const fresh = await pi.request({ type: "new_session" });
      console.log(`new_session: ${ms(fresh.elapsed)}`);
      await pi.request({ type: "set_model", provider, modelId: rest.join("/") });
      await pi.request({ type: "set_thinking_level", level: "off" });
      const sentAt = now();
      let firstDeltaAt;
      const settled = new Promise((resolve) => {
        pi.listeners.add((record, at) => {
          const delta = record.assistantMessageEvent?.type;
          if (
            firstDeltaAt === undefined &&
            record.type === "message_update" &&
            (delta === "text_delta" || delta === "thinking_delta")
          ) {
            firstDeltaAt = at;
          }
          if (record.type === "agent_settled") resolve(at);
        });
      });
      const ack = await pi.request({ type: "prompt", message: "Reply with exactly: ok" });
      const settledAt = await settled;
      console.log(`prompt ack: ${ms(ack.elapsed)}`);
      console.log(
        `prompt -> first delta: ${firstDeltaAt === undefined ? "none" : ms(firstDeltaAt - sentAt)}`,
      );
      console.log(`prompt -> agent_settled: ${ms(settledAt - sentAt)}`);
    }
  } finally {
    pi.child.kill("SIGTERM");
    mcp?.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

await main();
