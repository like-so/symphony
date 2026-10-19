import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Opt-in: Node 22+ runner and LETTA_TEST_BINARY pointing to a built letta.js.
// LETTA_TEST_RUNTIME can select the native server interpreter (for example Bun).
// Optional LETTA_TEST_CONSUMER_COMMAND is a JSON argv array for a verifier that
// reads {started, ended} serialized bridge frames on stdin and exits nonzero on failure.
const binary = process.env.LETTA_TEST_BINARY;
const nativeRuntime = process.env.LETTA_TEST_RUNTIME || process.execPath;

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function messages(failure) {
  const values = [];
  const listeners = new Set();
  return {
    values,
    push(value) {
      values.push(value);
      for (const listener of listeners) listener(value);
    },
    wait(predicate) {
      const existing = values.find(predicate);
      if (existing) return Promise.resolve(existing);
      return Promise.race([
        failure,
        new Promise((resolve) => {
          const listener = (value) => {
            if (!predicate(value)) return;
            listeners.delete(listener);
            resolve(value);
          };
          listeners.add(listener);
        }),
      ]);
    },
  };
}

function responseEvents(path) {
  if (path.endsWith("/chat/completions")) {
    const base = {
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4.1",
    };
    return (
      [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "WIRE_OK" },
              finish_reason: null,
            },
          ],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]
        .map((value) => `data: ${JSON.stringify(value)}\n\n`)
        .join("") + "data: [DONE]\n\n"
    );
  }
  const part = { type: "output_text", text: "WIRE_OK", annotations: [] };
  const item = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [part],
  };
  const events = [
    {
      type: "response.created",
      response: { id: "resp_fixture", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      part: { ...part, text: "" },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      delta: "WIRE_OK",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  return events
    .map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    .join("");
}

for (const earlyHeaders of [false, true]) {
  test(
    `packaged server forwards first-wait controls (${earlyHeaders ? "early" : "delayed"} HTTP headers)`,
    {
      skip: !binary,
      timeout: 60_000,
    },
    async (t) => {
      const home = await mkdtemp(join(tmpdir(), "provider-wait-process-"));
      const children = [];
      const requested = deferred();
      const release = deferred();
      let cleaningUp = false;
      let rejectFailure;
      const failure = new Promise((_, reject) => {
        rejectFailure = reject;
      });
      failure.catch(() => {});
      const fail = (error) => {
        if (!cleaningUp) rejectFailure(error);
      };
      const parse = (sink, text) => {
        try {
          const value = JSON.parse(String(text));
          if (!value || typeof value !== "object")
            throw new Error("Invalid protocol frame");
          sink.push(value);
        } catch (error) {
          fail(error);
        }
      };
      let socket;
      const http = createServer(async (request, response) => {
        request.resume();
        if (
          request.method !== "POST" ||
          !/\/(responses|chat\/completions)$/.test(request.url)
        ) {
          response.writeHead(404).end();
          fail(new Error("Unexpected provider fixture request"));
          return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        if (earlyHeaders) response.flushHeaders();
        requested.resolve();
        await release.promise;
        response.end(responseEvents(request.url));
      });
      t.after(async () => {
        cleaningUp = true;
        release.resolve();
        socket?.close();
        const stopped = await Promise.allSettled(
          children.map(async (child) => {
            if (
              !child.pid ||
              child.exitCode !== null ||
              child.signalCode !== null
            )
              return;
            const closed = once(child, "exit");
            child.kill("SIGTERM");
            const force = setTimeout(() => child.kill("SIGKILL"), 2000);
            try {
              await bounded(closed, 5000, "Owned child did not exit");
            } finally {
              clearTimeout(force);
            }
          }),
        );
        try {
          http.closeAllConnections();
          await bounded(
            new Promise((r) => http.close(r)),
            2000,
            "Fixture server did not close",
          );
        } finally {
          await rm(home, { recursive: true, force: true });
          await assert.rejects(access(home), { code: "ENOENT" });
        }
        assert.deepEqual(
          stopped.filter((result) => result.status === "rejected"),
          [],
        );
      });
      http.listen(0, "127.0.0.1");
      await once(http, "listening");
      const origin = `http://127.0.0.1:${http.address().port}`;
      const preload = `const original = globalThis.fetch; globalThis.fetch = (input, init) => {
    const request = new Request(input, init); const url = new URL(request.url);
    if (url.protocol === "data:") return original(request);
    if (url.origin !== "https://api.openai.com") throw new Error("Unexpected fetch origin in provider fixture");
    return original(new Request(${JSON.stringify(origin)} + url.pathname + url.search, request));
  };`;
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        LETTA_HOME: join(home, ".letta"),
        LETTA_LOCAL_BACKEND_DIR: join(home, "store"),
        LETTA_LOCAL_BACKEND_EXPERIMENTAL: "true",
        OPENAI_API_KEY: "fixture-key",
        LETTA_DISABLE_MODS: "1",
        LETTA_DISABLE_CRON_SCHEDULER: "1",
        LETTA_DESKTOP_CREDENTIALS_IPC: "0",
        DISABLE_AUTOUPDATER: "1",
      };
      const preloadPath = join(home, "provider-preload.mjs");
      await writeFile(preloadPath, preload, { mode: 0o600 });
      const native = spawn(
        nativeRuntime,
        [
          "--import",
          preloadPath,
          resolve(binary),
          "server",
          "--backend",
          "local",
          "--listen",
          "ws://127.0.0.1:0",
        ],
        { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(native);
      native.on("error", fail);
      native.on("exit", (code) =>
        fail(new Error(`Native server exited ${code}`)),
      );
      let startup = "";
      let diagnostics = "";
      native.stderr.on("data", (chunk) => {
        diagnostics += String(chunk);
      });
      const url = await new Promise((resolveUrl, reject) => {
        native.stdout.on("data", (chunk) => {
          startup += String(chunk);
          const match = startup.match(/WebSocket: (ws:\/\/[^\s]+)/);
          if (match) resolveUrl(match[1]);
        });
        native.once("error", reject);
        native.once("exit", (code) =>
          reject(
            new Error(
              `Native server exited ${code}: ${diagnostics.replaceAll(home, "[fixture home]")}`,
            ),
          ),
        );
      });
      socket = new WebSocket(url);
      await once(socket, "open");
      const bootstrap = messages(failure);
      socket.addEventListener("message", (event) =>
        parse(bootstrap, event.data),
      );
      socket.addEventListener("error", () =>
        fail(new Error("Bootstrap socket failed")),
      );
      socket.addEventListener("close", () =>
        fail(new Error("Bootstrap socket closed")),
      );
      socket.send(
        JSON.stringify({
          type: "runtime_start",
          request_id: "bootstrap",
          create_agent: {
            body: {
              name: "Provider wait fixture",
              model: "openai/gpt-4.1",
              system: "Reply WIRE_OK without tools.",
              tools: [],
            },
            pin_global: false,
            memfs: false,
          },
          create_conversation: {},
          cwd: home,
          skill_sources: [],
          recover_approvals: false,
          wait_for_replay: true,
        }),
      );
      const started = await bootstrap.wait(
        (value) => value.type === "runtime_start_response",
      );
      assert.equal(started.success, true, started.error);
      const bridge = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../bin/codex-bridge.mjs", import.meta.url)),
          "--app-server-url",
          url,
          "--agent",
          started.runtime.agent_id,
          "--workflow",
          "single",
        ],
        { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] },
      );
      children.push(bridge);
      let bridgeDiagnostics = "";
      bridge.stderr.on("data", (chunk) => {
        bridgeDiagnostics += String(chunk);
      });
      bridge.on("error", fail);
      bridge.on("exit", (code) =>
        fail(
          new Error(
            `Bridge exited ${code}: ${bridgeDiagnostics.replaceAll(home, "[fixture home]")}`,
          ),
        ),
      );
      const frames = messages(failure);
      let buffer = "";
      bridge.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line) parse(frames, line);
        }
      });
      const send = (value) => bridge.stdin.write(JSON.stringify(value) + "\n");
      send({ id: 1, method: "initialize", params: {} });
      const initialized = await frames.wait((value) => value.id === 1);
      assert.equal(initialized.error, undefined);
      assert.ok(initialized.result);
      send({ id: 2, method: "thread/start", params: { cwd: home } });
      const thread = await frames.wait((value) => value.id === 2);
      assert.equal(thread.error, undefined);
      assert.equal(typeof thread.result?.thread?.id, "string");
      send({
        id: 3,
        method: "turn/start",
        params: {
          threadId: thread.result.thread.id,
          input: [{ type: "text", text: "Reply WIRE_OK." }],
        },
      });
      const turn = await frames.wait((value) => value.id === 3);
      assert.equal(turn.error, undefined);
      assert.equal(typeof turn.result?.turn?.id, "string");
      const beginning = await frames.wait(
        (value) =>
          value.method === "turn/providerFirstWait" &&
          value.params.phase === "started",
      );
      await Promise.race([failure, requested.promise]);
      assert.equal(typeof beginning.params.trace_id, "string");
      assert.ok(beginning.params.trace_id.length > 0);
      assert.equal(beginning.params.turnId, turn.result.turn.id);
      // Keep the HTTP response blocked across an observable interval.
      await Promise.race([failure, new Promise((r) => setTimeout(r, 100))]);
      assert.equal(
        frames.values.some(
          (value) =>
            value.method === "turn/completed" ||
            (value.method === "turn/providerFirstWait" &&
              value.params.phase === "ended"),
        ),
        false,
      );
      assert.ok(beginning.params.timeout_ms > 0);
      assert.ok(beginning.params.deadline_unix_ms > Date.now());
      release.resolve();
      const ending = await frames.wait(
        (value) =>
          value.method === "turn/providerFirstWait" &&
          value.params.phase === "ended",
      );
      assert.equal(ending.params.trace_id, beginning.params.trace_id);
      if (process.env.LETTA_TEST_CONSUMER_COMMAND) {
        const command = JSON.parse(process.env.LETTA_TEST_CONSUMER_COMMAND);
        assert.ok(Array.isArray(command) && command.length > 0 && command.every(value => typeof value === "string"));
        const verification = spawnSync(command[0], command.slice(1), {
          input: JSON.stringify({ started: beginning, ended: ending }),
          encoding: "utf8",
          timeout: 15_000,
        });
        assert.equal(verification.error, undefined);
        assert.equal(verification.status, 0, verification.stderr);
        assert.match(verification.stdout, /provider wait consumer verified/);
      }
      const completed = await frames.wait(
        (value) => value.method === "turn/completed",
      );
      assert.equal(completed.params.outcome, undefined);
      assert.ok(
        frames.values.some(
          (value) =>
            value.method === "item/agent_message" &&
            value.params.text.includes("WIRE_OK"),
        ),
      );
    },
  );
}
