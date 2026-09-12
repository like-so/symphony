import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeTestHooks as bridge } from "../bin/codex-bridge.mjs";

function fixture() {
  const runtime = { agent_id: "agent", conversation_id: "conversation" };
  const statuses = [];
  const stages = [];
  const handlers = new Set();
  const target = bridge.createCorrectionTarget({
    cwd: "/workspace",
    symphony: { issueId: "issue", issueIdentifier: "LIKE-179", workerPid: "123", workerHost: null },
  }, "owner-turn", null, runtime);
  target.phaseActive = true;
  target.emitStatus = (item, status, extra) => statuses.push({ id: item.instructionId, status, ...extra });
  const correction = {
    ...target.binding, expectedTurnId: target.turnId,
    instructionId: "new-recovery", text: "Explicit new manager instruction",
    recovery: true, sourceRevision: "source-v2", authorizationId: "authorization-v2", cwdRevision: 4,
  };
  const loop = { status: "WAITING_ON_INPUT", active_run_ids: [], executing_tool_call_ids: [] };
  const device = { current_working_directory: "/workspace", cwd_revision: 4, background_processes: [] };
  const emit = (message) => { for (const handler of handlers) handler(message); };
  target.client = {
    onMessage(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    async request(type, body) {
      assert.equal(type, "sync");
      assert.equal(body.recover_approvals, false);
      assert.equal(body.force_device_status, true);
      assert.deepEqual(body.runtime, runtime);
      emit({ type: "update_loop_status", runtime, loop_status: loop });
      emit({ type: "update_device_status", runtime, device_status: device });
      return { type: "sync_response", request_id: body.request_id, runtime, success: true };
    },
  };
  target.validateAuthority = async (_target, item, stage) => {
    stages.push(stage);
    return { ...item, runtime, current: true };
  };
  const seen = new Set();
  const accept = (item = correction) => bridge.acceptCorrectionForTarget(target, item, seen);
  return { target, correction, loop, device, runtime, handlers, statuses, stages, emit, accept };
}

const success = { stopReason: "end_turn", runId: "new-run", text: "New result" };

test("recovery cannot silently downgrade malformed opt-in to a legacy queued correction", async () => {
  const f = fixture();
  assert.equal((await f.accept({ ...f.correction, recovery: "true" })).status, "failed");
  assert.equal(f.target.queue.length, 0);
});

test("successful owner phase is not an active stalled recovery target", async () => {
  const f = fixture();
  await bridge.submitWorkflowPhase(f.target, "Original", {}, async () => success);
  assert.equal((await f.accept()).status, "blocked");
  assert.equal(f.target.queue.length, 0);
});

test("explicit idle recovery replaces stale queue, validates twice, and submits exactly one new input", async () => {
  const f = fixture();
  f.target.queue.push({ instructionId: "stale-queued", text: "Do not replay" });
  assert.equal((await f.accept()).status, "delivered");
  let submissions = 0;
  await bridge.drainCorrections(f.target, {}, async (_client, _runtime, text, _turn, _usage, hooks) => {
    submissions++;
    assert.equal(text, f.correction.text);
    assert.equal(hooks.clientMessageId, "symphony-correction-new-recovery");
    hooks.onAccepted({ accepted: true });
    hooks.onExecutionStarted("new-run");
    return success;
  });
  assert.equal(submissions, 1);
  assert.deepEqual(f.stages, ["acceptance", "submission"]);
  assert.deepEqual(f.statuses.map((s) => [s.id, s.status]), [
    ["stale-queued", "failed"], ["new-recovery", "execution_started"], ["new-recovery", "completed"],
  ]);
  assert.equal(f.target.recoveryTakenOver, true);
  assert.equal(f.handlers.size, 0);
});

for (const status of ["PROCESSING_API_RESPONSE", "EXECUTING_CLIENT_SIDE_TOOL", "WAITING_ON_APPROVAL"]) {
  test(`inspection-only ${status} remains blocked without sending input or aborting`, async () => {
    const f = fixture();
    f.loop.status = status;
    if (status === "EXECUTING_CLIENT_SIDE_TOOL") f.loop.executing_tool_call_ids = ["Bash-call"];
    assert.equal((await f.accept()).status, "delivered");
    await bridge.drainCorrections(f.target, {}, () => assert.fail("must not submit"));
    assert.equal(f.statuses.at(-1).status, "blocked");
    assert.match(f.statuses.at(-1).error, /safe idle/);
    assert.equal(f.target.recoveryTakenOver, undefined);
    assert.equal(f.handlers.size, 0);
    assert.equal((await f.accept()).status, "failed", "blocked ID cannot be replayed");
  });
}

for (const mutation of [
  (f) => { f.device.background_processes = [{ pid: 999, status: "running" }]; },
  (f) => { f.device.cwd_revision = 5; },
  (f) => { f.device.current_working_directory = "/other"; },
  (f) => { f.loop.active_run_ids = ["unresolved-original-run"]; },
  (f) => { delete f.loop.executing_tool_call_ids; },
]) {
  test("recovery refuses incomplete idle evidence, background processes, or changed workspace", async () => {
    const f = fixture();
    mutation(f);
    await f.accept();
    await bridge.drainCorrections(f.target, {}, () => assert.fail("must not submit"));
    assert.equal(f.statuses.at(-1).status, "blocked");
  });
}

for (const stage of ["acceptance", "submission"]) {
  for (const field of ["sourceRevision", "authorizationId", "sessionId", "workerPid", "workerHost", "text"]) {
    test(`${stage} rejects stale or superseded ${field}`, async () => {
      const f = fixture();
      f.target.validateAuthority = async (_target, item, currentStage) => ({
        ...item, runtime: f.runtime, current: true,
        ...(currentStage === stage ? { [field]: "changed" } : {}),
      });
      const accepted = await f.accept();
      if (stage === "acceptance") {
        assert.equal(accepted.status, "blocked");
        assert.equal(f.target.queue.length, 0);
      } else {
        assert.equal(accepted.status, "delivered");
        await bridge.drainCorrections(f.target, {}, () => assert.fail("must not submit"));
        assert.equal(f.statuses.at(-1).status, "blocked");
      }
    });
  }
}

test("duplicate IDs are reserved during asynchronous validation and recovery requests cannot race", async () => {
  const f = fixture();
  let release;
  f.target.validateAuthority = () => new Promise((resolve) => { release = resolve; });
  const first = f.accept();
  assert.equal((await f.accept()).error, "duplicate instruction id");
  assert.equal((await f.accept({ ...f.correction, instructionId: "second" })).status, "blocked");
  release({ ...f.correction, runtime: f.runtime, current: true });
  assert.equal((await first).status, "delivered");
  assert.equal(f.target.queue.length, 1);
});

test("owner close while manager validation is pending blocks acceptance", async () => {
  const f = fixture();
  f.target.validateAuthority = async (_target, item) => {
    f.target.accepting = false;
    return { ...item, runtime: f.runtime, current: true };
  };
  assert.equal((await f.accept()).status, "blocked");
  assert.equal(f.target.queue.length, 0);
});

for (const change of [
  (f) => { f.target.binding.workerPid = "456"; },
  (f) => { f.target.runtime = { ...f.runtime, conversation_id: "other" }; },
  (f) => f.emit({ type: "update_loop_status", runtime: f.runtime, loop_status: { ...f.loop, status: "EXECUTING_CLIENT_SIDE_TOOL", executing_tool_call_ids: ["Bash"] } }),
  (f) => f.emit({ type: "update_device_status", runtime: f.runtime, device_status: { ...f.device, cwd_revision: 5 } }),
]) {
  test("state changes during submission authority check are revalidated before input", async () => {
    const f = fixture();
    f.target.validateAuthority = async (_target, item, stage) => {
      if (stage === "submission") change(f);
      return { ...item, runtime: f.runtime, current: true };
    };
    await f.accept();
    await bridge.drainCorrections(f.target, {}, () => assert.fail("must not submit"));
    assert.equal(f.statuses.at(-1).status, "blocked");
  });
}

for (const variant of ["missing-runtime", "wrong-runtime", "wrong-request", "failed-sync", "transport-loss", "missing-device"]) {
  test(`native inspection fails closed on ${variant}`, async () => {
    const f = fixture();
    const originalRequest = f.target.client.request;
    f.target.client.request = async (type, body) => {
      if (variant === "transport-loss") throw new Error("transport lost");
      if (variant === "missing-device") {
        f.emit({ type: "update_loop_status", runtime: f.runtime, loop_status: f.loop });
        return { type: "sync_response", request_id: body.request_id, runtime: f.runtime, success: true };
      }
      const response = await originalRequest(type, body);
      if (variant === "missing-runtime") delete response.runtime;
      if (variant === "wrong-runtime") response.runtime = { ...f.runtime, conversation_id: "other" };
      if (variant === "wrong-request") response.request_id = "other";
      if (variant === "failed-sync") response.success = false;
      return response;
    };
    await f.accept();
    await bridge.drainCorrections(f.target, {}, () => assert.fail("must not submit"));
    assert.equal(f.statuses.at(-1).status, "blocked");
    assert.equal(f.handlers.size, 0);
  });
}

test("one drain promise serializes concurrent callers", async () => {
  const f = fixture();
  await f.accept();
  let release;
  let submissions = 0;
  const submit = () => { submissions++; return new Promise((resolve) => { release = resolve; }); };
  const first = bridge.drainCorrections(f.target, {}, submit);
  const second = bridge.drainCorrections(f.target, {}, submit);
  assert.equal(first, second);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release(success);
  await Promise.all([first, second]);
  assert.equal(submissions, 1);
});

test("new recovery terminal does not revive an unresolved original phase", async () => {
  const f = fixture();
  f.target.phaseActive = false;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const original = bridge.submitWorkflowPhase(f.target, "Original phase", {}, async (_client, _runtime, _prompt, _turn, _usage, hooks) => {
    ready();
    return hooks.localStop;
  });
  const originalFailed = assert.rejects(original, (error) => {
    assert.match(error.message, /Original phase outcome unresolved/);
    assert.equal(error.recoveryInstructionId, "new-recovery");
    return true;
  });
  await started;
  await f.accept();
  await bridge.drainCorrections(f.target, {}, async () => success);
  await originalFailed;
  assert.equal(f.statuses.at(-1).status, "completed");
  assert.equal(f.target.accepting, false);
});

for (const stopReason of ["llm_api_error", "cancelled", "timeout"]) {
  test(`new recovery after original ${stopReason} is refused rather than reopening target`, async () => {
    const f = fixture();
    await assert.rejects(bridge.submitWorkflowPhase(f.target, "Original", {}, async () => {
      if (stopReason === "timeout") throw new Error("timeout");
      return { stopReason };
    }));
    assert.equal((await f.accept()).status, "failed");
    assert.equal(f.target.queue.length, 0);
  });
}

test("recovery transport loss after submission stays unresolved and is never retried", async () => {
  const f = fixture();
  await f.accept();
  let count = 0;
  const result = await bridge.drainCorrections(f.target, {}, async () => {
    count++;
    const error = new Error("terminal correlation unresolved after transport loss");
    error.correctionOutcomeUnresolved = true;
    throw error;
  });
  assert.equal(result.outcomeUnresolved, true);
  assert.equal(f.statuses.at(-1).status, "failed");
  await bridge.drainCorrections(f.target, {}, () => assert.fail("no retry"));
  assert.equal(count, 1);
});

for (const runtime of [undefined, { conversation_id: "conversation" }, { agent_id: "other", conversation_id: "conversation" }]) {
  test("authority never accepts a permissive partial or mismatched runtime", async () => {
    const f = fixture();
    f.target.validateAuthority = async (_target, item) => ({ ...item, runtime, current: true });
    assert.equal((await f.accept()).status, "blocked");
  });
}

test("unscoped state updates cannot provide native idle authority", async () => {
  const f = fixture();
  f.target.client.request = async (_type, body) => {
    f.emit({ type: "update_loop_status", loop_status: f.loop });
    f.emit({ type: "update_device_status", device_status: f.device });
    return { type: "sync_response", request_id: body.request_id, runtime: f.runtime, success: true };
  };
  await f.accept();
  await bridge.drainCorrections(f.target, {}, () => assert.fail("must not submit"));
  assert.equal(f.statuses.at(-1).status, "blocked");
});

test("native interleaved original and recovery run terminals retain separate outcomes", async () => {
  const f = fixture();
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const clientIds = [];
  f.target.client.waitForClose = () => new Promise(() => {});
  f.target.client.submitInput = async (body) => {
    const id = body.payload.messages[0].client_message_id;
    clientIds.push(id);
    const owner = clientIds.length === 1;
    const runId = owner ? "original-run" : "recovery-run";
    f.emit({ type: "update_loop_status", runtime: f.runtime, loop_status: {
      status: "PROCESSING_API_RESPONSE", active_run_ids: [runId],
      client_message_ids_by_run_id: { [runId]: [id] }, executing_tool_call_ids: [],
    } });
    if (owner) {
      ready();
    } else {
      f.emit({ type: "turn_finished", runtime: f.runtime, run_id: "original-run", turn_id: "native-original", stop_reason: "llm_api_error" });
      f.emit({ type: "turn_finished", runtime: f.runtime, run_id: "recovery-run", turn_id: "native-recovery", stop_reason: "end_turn" });
    }
    return { accepted: true, disposition: "started" };
  };
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const originalFailed = assert.rejects(bridge.submitWorkflowPhase(f.target, "Original", usage), /Original phase outcome unresolved/);
  await started;
  assert.equal((await f.accept()).status, "delivered");
  await bridge.drainCorrections(f.target, usage);
  await originalFailed;
  assert.equal(clientIds.length, 2);
  assert.notEqual(clientIds[0], clientIds[1]);
  assert.equal(f.statuses.at(-1).status, "completed");
  assert.equal(f.statuses.at(-1).runId, "recovery-run");
  assert.equal(f.handlers.size, 0);
});
