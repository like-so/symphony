import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { bridgeTestHooks } from "../bin/codex-bridge.mjs";

const { AppServerProcessManager, resolveAppServer } = bridgeTestHooks;

class FakeChild extends EventEmitter {
  constructor({ exitOnTerm = true, exitOnKill = true } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.exitOnTerm = exitOnTerm;
    this.exitOnKill = exitOnKill;
    this.kills = [];
    this.pid = Math.floor(Math.random() * 100_000) + 1;
  }

  kill(signal) {
    this.kills.push(signal);
    if (
      (signal === "SIGTERM" && this.exitOnTerm) ||
      (signal === "SIGKILL" && this.exitOnKill)
    ) {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
      });
    }
    return true;
  }
}

function listeningSpawner(children, childOptions = {}) {
  return () => {
    const child = new FakeChild(childOptions);
    children.push(child);
    setImmediate(() =>
      child.stdout.write(
        `Listening on ws://127.0.0.1:${40_000 + children.length}\n`,
      ),
    );
    return child;
  };
}

test("normal turn cleanup terminates its owned App Server", async () => {
  const children = [];
  const manager = new AppServerProcessManager({
    isProcessGroupAlive: (child) =>
      Boolean(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null,
    spawnProcess: listeningSpawner(children),
    signalProcess: (child, signal) => child.kill(signal),
    shutdownTimeoutMs: 20,
  });
  const server = await manager.start({
    lettaBin: "letta",
    backend: "local",
    listenUrl: "ws://127.0.0.1:0",
    startTimeoutMs: 100,
  });

  assert.equal(manager.size, 1);
  await manager.stop(server.child);

  assert.deepEqual(children[0].kills, ["SIGTERM"]);
  assert.equal(manager.size, 0);
});

test("concurrent turns retain independent App Server ownership", async () => {
  const children = [];
  const manager = new AppServerProcessManager({
    isProcessGroupAlive: (child) =>
      Boolean(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null,
    spawnProcess: listeningSpawner(children),
    signalProcess: (child, signal) => child.kill(signal),
    shutdownTimeoutMs: 20,
  });
  const [first, second] = await Promise.all([
    manager.start({
      lettaBin: "letta",
      backend: "local",
      listenUrl: "ws://127.0.0.1:0",
      startTimeoutMs: 100,
    }),
    manager.start({
      lettaBin: "letta",
      backend: "local",
      listenUrl: "ws://127.0.0.1:0",
      startTimeoutMs: 100,
    }),
  ]);

  await manager.stop(first.child);
  assert.deepEqual(first.child.kills, ["SIGTERM"]);
  assert.deepEqual(second.child.kills, []);
  assert.equal(manager.size, 1);

  await manager.stop(second.child);
  assert.equal(manager.size, 0);
});

test("startup timeout terminates the spawned App Server", async () => {
  const child = new FakeChild();
  const manager = new AppServerProcessManager({
    isProcessGroupAlive: (child) =>
      Boolean(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null,
    spawnProcess: () => child,
    signalProcess: (target, signal) => target.kill(signal),
    shutdownTimeoutMs: 20,
  });

  await assert.rejects(
    manager.start({
      lettaBin: "letta",
      backend: "local",
      listenUrl: "ws://127.0.0.1:0",
      startTimeoutMs: 5,
    }),
    /Timed out waiting/,
  );

  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(manager.size, 0);
});

test("shutdown escalates from SIGTERM to SIGKILL", async () => {
  const children = [];
  const manager = new AppServerProcessManager({
    isProcessGroupAlive: (child) =>
      Boolean(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null,
    spawnProcess: listeningSpawner(children, {
      exitOnTerm: false,
      exitOnKill: true,
    }),
    signalProcess: (child, signal) => child.kill(signal),
    shutdownTimeoutMs: 5,
  });
  const server = await manager.start({
    lettaBin: "letta",
    backend: "local",
    listenUrl: "ws://127.0.0.1:0",
    startTimeoutMs: 100,
  });

  await manager.stop(server.child);

  assert.deepEqual(server.child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(manager.size, 0);
});

test("stdin or signal cleanup can terminate all owned App Servers", async () => {
  const children = [];
  const manager = new AppServerProcessManager({
    isProcessGroupAlive: (child) =>
      Boolean(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null,
    spawnProcess: listeningSpawner(children),
    signalProcess: (child, signal) => child.kill(signal),
    shutdownTimeoutMs: 20,
  });
  await Promise.all([
    manager.start({
      lettaBin: "letta",
      backend: "local",
      listenUrl: "ws://127.0.0.1:0",
      startTimeoutMs: 100,
    }),
    manager.start({
      lettaBin: "letta",
      backend: "local",
      listenUrl: "ws://127.0.0.1:0",
      startTimeoutMs: 100,
    }),
  ]);

  await manager.stopAll();

  assert.deepEqual(
    children.map((child) => child.kills),
    [["SIGTERM"], ["SIGTERM"]],
  );
  assert.equal(manager.size, 0);
});

test("external app-server URL is never owned or terminated", async () => {
  let startCalls = 0;
  const manager = {
    start: async () => {
      startCalls += 1;
      throw new Error("must not start");
    },
  };

  const server = await resolveAppServer({
    appServerUrl: "ws://127.0.0.1:4500",
    manager,
  });

  assert.deepEqual(server, { url: "ws://127.0.0.1:4500", child: null });
  assert.equal(startCalls, 0);
});

test("racing cleanup paths share one termination sequence", async () => {
  const children = [];
  const manager = new AppServerProcessManager({
    isProcessGroupAlive: (child) =>
      Boolean(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null,
    spawnProcess: listeningSpawner(children),
    signalProcess: (child, signal) => child.kill(signal),
    shutdownTimeoutMs: 20,
  });
  const server = await manager.start({
    lettaBin: "letta",
    backend: "local",
    listenUrl: "ws://127.0.0.1:0",
    startTimeoutMs: 100,
  });

  await Promise.all([
    manager.stop(server.child),
    manager.stop(server.child),
    manager.stopAll(),
  ]);

  assert.deepEqual(server.child.kills, ["SIGTERM"]);
  assert.equal(manager.size, 0);
});

test("shutdown latch rejects a late local App Server spawn", async () => {
  let spawnCalls = 0;
  const manager = new AppServerProcessManager({
    isProcessGroupAlive: (child) =>
      Boolean(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null,
    spawnProcess: () => {
      spawnCalls += 1;
      return new FakeChild();
    },
    signalProcess: (child, signal) => child.kill(signal),
    shutdownTimeoutMs: 20,
  });

  await manager.stopAll();
  await assert.rejects(
    manager.start({
      lettaBin: "letta",
      backend: "local",
      listenUrl: "ws://127.0.0.1:0",
      startTimeoutMs: 100,
    }),
    /shutting down/,
  );
  assert.equal(spawnCalls, 0);
});

test("local App Servers are spawned as independent process groups", async () => {
  let observedOptions = null;
  const child = new FakeChild();
  const manager = new AppServerProcessManager({
    isProcessGroupAlive: (child) =>
      Boolean(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null,
    spawnProcess: (_command, _args, options) => {
      observedOptions = options;
      setImmediate(() =>
        child.stdout.write("Listening on ws://127.0.0.1:4500\n"),
      );
      return child;
    },
    signalProcess: (target, signal) => target.kill(signal),
    shutdownTimeoutMs: 20,
  });

  const server = await manager.start({
    lettaBin: "letta",
    backend: "local",
    listenUrl: "ws://127.0.0.1:0",
    startTimeoutMs: 100,
  });
  assert.equal(observedOptions.detached, process.platform !== "win32");
  await manager.stop(server.child);
});

test("spawn error without a child PID preserves the startup error and releases ownership", async () => {
  const child = new FakeChild();
  child.pid = undefined;
  const manager = new AppServerProcessManager({
    isProcessGroupAlive: (child) =>
      Boolean(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null,
    spawnProcess: () => {
      setImmediate(() => child.emit("error", new Error("spawn failed")));
      return child;
    },
    signalProcess: (target, signal) => target.kill(signal),
    shutdownTimeoutMs: 5,
  });

  await assert.rejects(
    manager.start({
      lettaBin: "missing",
      backend: "local",
      listenUrl: "ws://127.0.0.1:0",
      startTimeoutMs: 100,
    }),
    /spawn failed/,
  );
  assert.equal(manager.size, 0);
  assert.deepEqual(child.kills, []);
});

test("WebSocket close rejects terminal waits immediately", async () => {
  class FakeSocket extends EventTarget {
    send() {}
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  const socket = new FakeSocket();
  const client = bridgeTestHooks.createAppServerBridgeClientForTest(
    socket,
    10_000,
  );
  const closed = client.waitForClose();

  socket.close();

  await assert.rejects(closed, /WebSocket closed/);
});

test(
  "cleanup kills a TERM-resistant descendant after the process-group leader exits",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "letta-process-group-"));
    const fixturePath = join(fixtureDir, "fake-letta-server.mjs");
    const grandchildPidPath = join(fixtureDir, "grandchild.pid");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"], { stdio: "ignore" });
writeFileSync(process.env.FAKE_GRANDCHILD_PID_FILE, String(grandchild.pid));
console.log("Listening on ws://127.0.0.1:45556");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60000);
`,
    );
    await chmod(fixturePath, 0o755);

    const previousPidFile = process.env.FAKE_GRANDCHILD_PID_FILE;
    process.env.FAKE_GRANDCHILD_PID_FILE = grandchildPidPath;
    const manager = new AppServerProcessManager({ shutdownTimeoutMs: 100 });
    let server;
    let grandchildPid;
    try {
      server = await manager.start({
        lettaBin: fixturePath,
        backend: "local",
        listenUrl: "ws://127.0.0.1:0",
        startTimeoutMs: 1_000,
      });
      grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));

      await manager.stop(server.child);

      assert.equal(manager.size, 0);
      assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
    } finally {
      if (server?.child?.pid) {
        try {
          process.kill(-server.child.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      if (previousPidFile === undefined)
        delete process.env.FAKE_GRANDCHILD_PID_FILE;
      else process.env.FAKE_GRANDCHILD_PID_FILE = previousPidFile;
      await rm(fixtureDir, { force: true, recursive: true });
    }
  },
);
