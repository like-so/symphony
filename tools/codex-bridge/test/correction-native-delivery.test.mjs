import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeTestHooks as bridge } from "../bin/codex-bridge.mjs";

function fixture() {
  const runtime = { agent_id: "agent", conversation_id: "owner" };
  const handlers = new Set();
  const submissions = [];
  const statuses = [];
  const client = {
    onMessage(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    submitInput(input) {
      return new Promise((resolve, reject) => submissions.push({ input, resolve, reject }));
    },
    waitForClose() { return new Promise(() => {}); },
  };
  const target = bridge.createCorrectionTarget({ cwd: "/workspace", symphony: {
    issueId: "issue", issueIdentifier: "LIKE-179", workerPid: "123", workerHost: null,
  } }, "turn", client, runtime);
  target.emitStatus = (item, status, extra) => statuses.push({ id: item.instructionId, status, ...extra });
  const correction = { ...target.binding, expectedTurnId: target.turnId,
    instructionId: "correction", text: "Change the active owner instruction" };
  const emit = (message) => { for (const handler of handlers) handler({ runtime, ...message }); };
  const finish = (submission, runId) => {
    const id = submission.input.payload.messages[0].client_message_id;
    emit({ type: "update_loop_status", loop_status: {
      active_run_ids: [runId], client_message_ids_by_run_id: { [runId]: [id] },
    } });
    emit({ type: "turn_finished", run_id: runId, turn_id: "native-turn", stop_reason: "end_turn" });
  };
  return { target, correction, client, runtime, handlers, submissions, statuses, emit, finish };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("bridge receipt is not native delivery while the owner is busy", async () => {
  const f = fixture();
  f.target.phaseActive = true;
  const result = await bridge.acceptCorrectionForTarget(f.target, f.correction, new Set());
  assert.equal(result.status, "received");
  assert.equal(f.submissions.length, 0);
  assert.equal(f.statuses.length, 0);
});

for (const status of ["EXECUTING_CLIENT_SIDE_TOOL", "PROCESSING_API_RESPONSE"]) {
  test(`ordinary input reaches native queue during ${status}, before owner completion`, async () => {
    const f = fixture();
    const phase = bridge.submitWorkflowPhase(f.target, "Owner phase", { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    f.submissions[0].resolve({ accepted: true, disposition: "started" });
    const ownerId = f.submissions[0].input.payload.messages[0].client_message_id;
    f.emit({ type: "update_loop_status", loop_status: {
      status, active_run_ids: ["owner-run"],
      executing_tool_call_ids: status === "EXECUTING_CLIENT_SIDE_TOOL" ? ["busy-tool"] : [],
      client_message_ids_by_run_id: { "owner-run": [ownerId] },
    } });
    const receipt = [];
    await bridge.acceptCorrection("request", f.correction, f.target,
      (_id, result) => receipt.push(result.correction), new Set());
    await tick();
    assert.equal(f.submissions.length, 2, "must submit before phase terminal");
    assert.equal(receipt[0].status, "received");
    assert.deepEqual(f.submissions[1].input.runtime, f.runtime);
    assert.equal(f.submissions[1].input.payload.messages[0].content[0].text, f.correction.text);
    assert.equal(f.statuses.length, 0, "writing a socket is not delivery");
    // A queued acknowledgement can mention the original run. It is not
    // execution evidence for this new client_message_id.
    f.submissions[1].resolve({ accepted: true, disposition: "queued", run_id: "owner-run" });
    await tick();
    assert.deepEqual(f.statuses.map((s) => s.status), ["delivered"]);
    f.finish(f.submissions[0], "owner-run");
    let phaseEnded = false;
    phase.then(() => { phaseEnded = true; });
    await tick();
    assert.equal(phaseEnded, false, "keep owner waiter alive for correction result");
    f.finish(f.submissions[1], "correction-run");
    await phase;
    assert.deepEqual(f.statuses.map((s) => s.status), ["delivered", "execution_started", "completed"]);
    assert.equal(f.handlers.size, 0);
  });
}

const usage = () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
async function start(f) {
  const phase = bridge.submitWorkflowPhase(f.target, "Owner phase", usage());
  // Attach before deliberately exercising rejection paths.
  phase.catch(() => {});
  f.submissions[0].resolve({ accepted: true, disposition: "started" });
  await tick();
  return { phase };
}
async function deliver(f, correction = f.correction, seen = new Set()) {
  let receipt;
  await bridge.acceptCorrection("request", correction, f.target,
    (_id, result) => { receipt = result.correction; }, seen);
  await tick();
  return receipt;
}

test("native rejection never becomes delivered; duplicate and closed targets never submit", async () => {
  const f = fixture();
  const { phase } = await start(f);
  const seen = new Set();
  assert.equal((await deliver(f, f.correction, seen)).status, "received");
  f.submissions[1].resolve({ accepted: false, error: "Runtime is no longer active" });
  await f.target.drainPromise;
  assert.deepEqual(f.statuses.map((s) => s.status), ["failed"]);
  assert.equal((await deliver(f, f.correction, seen)).status, "failed");
  f.target.accepting = false;
  assert.equal((await deliver(f, { ...f.correction, instructionId: "closed" })).status, "failed");
  assert.equal(f.submissions.length, 2);
  f.finish(f.submissions[0], "owner-run");
  await phase;
  assert.equal(f.handlers.size, 0);
});

test("a second ordinary correction reaches native acceptance before the first terminal", async () => {
  const f = fixture();
  const { phase } = await start(f);
  await deliver(f);
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  f.emit({ type: "update_loop_status", loop_status: {
    active_run_ids: ["first-run"], client_message_ids_by_run_id: {
      "first-run": ["symphony-correction-correction"],
    },
  } });
  await tick();
  await deliver(f, { ...f.correction, instructionId: "second", text: "Second instruction" });
  assert.equal(f.submissions.length, 3, "submit guidance while the first correction is executing");
  assert.deepEqual(f.submissions[2].input.runtime, f.runtime);
  assert.equal(f.submissions[2].input.payload.messages[0].content[0].text, "Second instruction");
  assert.equal(f.submissions[2].input.payload.messages[0].client_message_id, "symphony-correction-second");
  f.submissions[2].resolve({ accepted: true, disposition: "queued", run_id: "first-run" });
  await tick();
  assert.deepEqual(f.statuses.filter((s) => s.id === "second").map((s) => s.status), ["delivered"]);
  assert.equal(f.statuses.some((s) => s.status === "completed"), false);
  let phaseEnded = false;
  phase.then(() => { phaseEnded = true; });
  f.finish(f.submissions[0], "owner-run");
  f.finish(f.submissions[1], "first-run");
  await tick();
  assert.equal(phaseEnded, false, "phase must retain every outstanding outcome waiter");
  f.finish(f.submissions[2], "second-run");
  await phase;
  assert.deepEqual(f.statuses.filter((s) => s.status === "completed").map((s) => s.id), ["correction", "second"]);
  assert.equal(f.handlers.size, 0);
});

test("owner and correction can share a native continuation without duplicate completion", async () => {
  const f = fixture();
  const { phase } = await start(f);
  await deliver(f);
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  await tick();
  const ids = f.submissions.map((s) => s.input.payload.messages[0].client_message_id);
  f.emit({ type: "update_queue", removed: [{ client_message_id: ids[1], disposition: "dequeued" }] });
  f.emit({ type: "update_loop_status", loop_status: {
    active_run_ids: ["shared-continuation"], client_message_ids_by_run_id: { "shared-continuation": ids },
  } });
  f.emit({ type: "turn_finished", run_id: "shared-continuation", stop_reason: "end_turn" });
  await phase;
  f.emit({ type: "turn_finished", run_id: "shared-continuation", stop_reason: "end_turn" });
  assert.equal(f.statuses.filter((s) => s.status === "completed").length, 1);
  assert.equal(f.statuses.at(-1).runId, "shared-continuation");
  assert.equal(f.handlers.size, 0);
});

for (const stopReason of ["cancelled", "llm_api_error", "requires_approval"]) {
  test(`owner ${stopReason} releases all in-flight waiters and fails unsent queue`, async () => {
    const f = fixture();
    const { phase } = await start(f);
    await deliver(f);
    await deliver(f, { ...f.correction, instructionId: "later" });
    f.submissions[1].resolve({ accepted: true, disposition: "queued" });
    await tick();
    await deliver(f, { ...f.correction, instructionId: "unsent" });
    const id = f.submissions[0].input.payload.messages[0].client_message_id;
    f.emit({ type: "update_loop_status", loop_status: {
      active_run_ids: ["owner-run"], client_message_ids_by_run_id: { "owner-run": [id] },
    } });
    f.emit({ type: "turn_finished", run_id: "owner-run", stop_reason: stopReason });
    await assert.rejects(phase);
    assert.equal(f.target.accepting, false);
    assert.equal(f.submissions.length, 3, "the third correction must remain unsent");
    assert.deepEqual(f.statuses.filter((s) => s.status === "failed").map((s) => s.id).sort(), ["correction", "later", "unsent"]);
    assert.equal(f.handlers.size, 0);
  });
}

test("cancelled native queue input is failed once and a late result cannot revive it", async () => {
  const f = fixture();
  const { phase } = await start(f);
  await deliver(f);
  const drain = f.target.drainPromise;
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  await tick();
  f.emit({ type: "update_queue", removed: [{
    client_message_id: "symphony-correction-correction", disposition: "cancelled",
  }] });
  await drain;
  f.finish(f.submissions[1], "too-late");
  f.finish(f.submissions[0], "owner-run");
  await phase;
  assert.deepEqual(f.statuses.map((s) => s.status), ["delivered", "failed"]);
  assert.equal(f.handlers.size, 0);
});

test("correlated terminal preceding a lost acceptance still emits ordered evidence once", async () => {
  const f = fixture();
  const { phase } = await start(f);
  await deliver(f);
  f.finish(f.submissions[1], "correction-run");
  f.submissions[1].reject(new Error("acceptance response lost"));
  f.finish(f.submissions[0], "owner-run");
  await phase;
  assert.deepEqual(f.statuses.map((s) => s.status), ["delivered", "execution_started", "completed"]);
  assert.equal(f.handlers.size, 0);
});

test("foreign or unscoped run evidence cannot complete an owner-bound correction", async () => {
  const f = fixture();
  const { phase } = await start(f);
  await deliver(f);
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  await tick();
  for (const runtime of [undefined, { agent_id: "agent", conversation_id: "foreign" }]) {
    f.emit({ runtime, type: "update_loop_status", loop_status: {
      active_run_ids: ["foreign-run"],
      client_message_ids_by_run_id: { "foreign-run": ["symphony-correction-correction"] },
    } });
    f.emit({ runtime, type: "turn_finished", run_id: "foreign-run", stop_reason: "end_turn" });
  }
  assert.deepEqual(f.statuses.map((s) => s.status), ["delivered"]);
  f.finish(f.submissions[1], "correct-run");
  f.finish(f.submissions[0], "owner-run");
  await phase;
  assert.equal(f.statuses.at(-1).runId, "correct-run");
});

for (const accepted of [false, true]) {
  test(`transport disconnect ${accepted ? "after" : "before"} acceptance releases all listeners and rejects late results`, async () => {
    class Socket extends EventTarget {
      sent = [];
      send(data) { this.sent.push(JSON.parse(data)); }
      emit(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
      close() { this.dispatchEvent(new Event("close")); }
    }
    const f = fixture();
    const socket = new Socket();
    f.target.client = bridge.createAppServerBridgeClientForTest(socket, 200);
    const phase = bridge.submitWorkflowPhase(f.target, "Owner phase", usage());
    phase.catch(() => {});
    socket.emit({ type: "input_accepted", runtime: f.runtime, request_id: socket.sent[0].request_id,
      accepted: true, disposition: "started" });
    await tick();
    await deliver(f);
    await deliver(f, { ...f.correction, instructionId: "later" });
    assert.equal(socket.sent.length, 2);
    if (accepted) {
      socket.emit({ type: "input_accepted", runtime: f.runtime, request_id: socket.sent[1].request_id,
        accepted: true, disposition: "queued" });
      await tick();
    }
    socket.close();
    await assert.rejects(phase, /closed|unresolved/);
    assert.equal(f.target.client.handlers.size, 0);
    assert.equal(f.target.client.pending.size, 0);
    const before = [...f.statuses];
    socket.emit({ type: "turn_finished", runtime: f.runtime, run_id: "late", stop_reason: "end_turn" });
    assert.deepEqual(f.statuses, before);
    assert.equal(f.statuses.filter((s) => s.status === "delivered").length, accepted ? 1 : 0);
    assert.deepEqual(f.statuses.filter((s) => s.status === "failed").map((s) => s.id).sort(), ["correction", "later"]);
  });
}

test("input received during provisioning waits for owner acceptance, then enters native queue", async () => {
  const f = fixture();
  const receipt = await deliver(f);
  assert.equal(receipt.status, "received");
  assert.equal(f.submissions.length, 0);
  const { phase } = await start(f);
  assert.equal(f.submissions.length, 2);
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  f.finish(f.submissions[1], "correction-run");
  f.finish(f.submissions[0], "owner-run");
  await phase;
  assert.equal(f.statuses.at(-1).status, "completed");
});

test("a failed owner terminal before its acceptance never starts queued corrections", async () => {
  const f = fixture();
  await deliver(f);
  const phase = bridge.submitWorkflowPhase(f.target, "Owner phase", usage());
  phase.catch(() => {});
  const id = f.submissions[0].input.payload.messages[0].client_message_id;
  f.emit({ type: "turn_finished", run_id: "owner-run", stop_reason: "llm_api_error" });
  f.emit({ type: "update_loop_status", loop_status: {
    active_run_ids: ["owner-run"], client_message_ids_by_run_id: { "owner-run": [id] },
  } });
  f.submissions[0].resolve({ accepted: true, disposition: "started" });
  await assert.rejects(phase);
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.statuses.map((s) => s.status), ["failed"]);
  assert.equal(f.handlers.size, 0);
});

test("a terminal buffered before dequeue cannot complete a correction when its continuation reuses the owner run", async () => {
  const f = fixture();
  const { phase } = await start(f);
  await deliver(f);
  f.submissions[1].resolve({ accepted: true, disposition: "queued", run_id: "owner-run" });
  await tick();
  // The correction listener has not seen an exact run mapping yet.
  f.emit({ type: "turn_finished", run_id: "owner-run", turn_id: "original-turn", stop_reason: "end_turn" });
  f.emit({ type: "update_queue", removed: [{
    client_message_id: "symphony-correction-correction", disposition: "dequeued",
  }] });
  const ids = f.submissions.map((s) => s.input.payload.messages[0].client_message_id);
  f.emit({ type: "update_loop_status", loop_status: {
    active_run_ids: ["owner-run"], client_message_ids_by_run_id: { "owner-run": ids },
  } });
  await tick();
  assert.equal(f.statuses.some((s) => s.status === "completed"), false,
    "the original turn terminal predates consumption of this correction");
  f.emit({ type: "turn_finished", run_id: "owner-run", turn_id: "correction-continuation", stop_reason: "end_turn" });
  await phase;
  assert.equal(f.statuses.at(-1).status, "completed");
});

for (const ownerMatches of [true, false]) {
  test(`queued wait ${ownerMatches ? "tracks the bound owner's" : "ignores unrelated"} activity`, async () => {
    const f = fixture();
    const waiting = bridge.submitAndWaitForTurn(f.client, f.runtime, "Correction", "turn", usage(), {
      clientMessageId: "symphony-correction-correction", turnTimeoutMs: 50,
      waitingOnOwnerClientMessageId: "owner-message", waitingOnOwnerRunId: "owner-run",
    });
    waiting.catch(() => {});
    f.submissions[0].resolve({ accepted: true, disposition: "queued" });
    const activity = setInterval(() => f.emit({ type: "stream_delta", delta: {
      run_id: ownerMatches ? "owner-run" : "unrelated-run", type: "reasoning_delta", reasoning: "working",
    } }), 10);
    let finishTimer;
    try {
      if (ownerMatches) {
        finishTimer = setTimeout(() => f.finish(f.submissions[0], "correction-run"), 130);
        assert.equal((await waiting).runId, "correction-run");
      } else {
        await assert.rejects(waiting, (error) => error.correctionOutcomeUnresolved === true);
      }
      assert.equal(f.handlers.size, 0);
    } finally {
      clearInterval(activity);
      clearTimeout(finishTimer);
    }
  });
}

test("a known original run terminal is never replayed after the new message joins that run", async () => {
  const f = fixture();
  const { phase } = await start(f);
  f.emit({ type: "update_loop_status", loop_status: {
    active_run_ids: ["owner-run"], client_message_ids_by_run_id: {
      "owner-run": [f.submissions[0].input.payload.messages[0].client_message_id],
    },
  } });
  await deliver(f);
  f.submissions[1].resolve({ accepted: true, disposition: "queued", run_id: "owner-run" });
  f.emit({ type: "turn_finished", run_id: "owner-run", turn_id: "old-turn", stop_reason: "end_turn" });
  f.emit({ type: "update_loop_status", loop_status: {
    active_run_ids: ["owner-run"], client_message_ids_by_run_id: {
      "owner-run": f.submissions.map((s) => s.input.payload.messages[0].client_message_id),
    },
  } });
  await tick();
  assert.equal(f.statuses.some((s) => s.status === "completed"), false);
  f.emit({ type: "turn_finished", run_id: "owner-run", turn_id: "new-turn", stop_reason: "end_turn" });
  await phase;
  assert.equal(f.statuses.at(-1).status, "completed");
});

test("a shared continuation approval terminal remains blocked, not an unresolved disconnect", async () => {
  const f = fixture();
  const { phase } = await start(f);
  await deliver(f);
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  await tick();
  f.target.emitInputRequired = () => {};
  f.emit({ type: "update_loop_status", loop_status: {
    active_run_ids: ["shared-run"], client_message_ids_by_run_id: {
      "shared-run": f.submissions.map((s) => s.input.payload.messages[0].client_message_id),
    },
  } });
  f.emit({ type: "turn_finished", run_id: "shared-run", turn_id: "continuation", stop_reason: "requires_approval" });
  await phase.catch(() => {});
  assert.deepEqual(f.statuses.map((s) => s.status), ["delivered", "execution_started", "blocked"]);
  assert.notEqual(f.target.correctionOutcomeUnresolved, true);
});

test("a post-dequeue reused-run terminal survives a delayed exact correlation snapshot", async () => {
  const f = fixture();
  const { phase } = await start(f);
  f.emit({ type: "update_loop_status", loop_status: {
    active_run_ids: ["owner-run"], client_message_ids_by_run_id: {
      "owner-run": [f.submissions[0].input.payload.messages[0].client_message_id],
    },
  } });
  await deliver(f);
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  f.emit({ type: "update_queue", removed: [{
    client_message_id: "symphony-correction-correction", disposition: "dequeued",
  }] });
  f.emit({ type: "turn_finished", run_id: "owner-run", turn_id: "new-turn", stop_reason: "end_turn" });
  f.emit({ type: "update_loop_status", loop_status: {
    active_run_ids: [], client_message_ids_by_run_id: {
      "owner-run": f.submissions.map((s) => s.input.payload.messages[0].client_message_id),
    },
  } });
  await phase;
  assert.deepEqual(f.statuses.map((s) => s.status), ["delivered", "execution_started", "completed"]);
  assert.equal(f.handlers.size, 0);
});

for (const disposition of [undefined, "unsupported"]) {
  test(`ordinary acceptance with ${disposition} disposition retains the terminal submission gate`, async () => {
    const f = fixture();
    const { phase } = await start(f);
    await deliver(f);
    await deliver(f, { ...f.correction, instructionId: "second" });
    f.submissions[1].resolve({ accepted: true, disposition });
    await tick();
    assert.equal(f.submissions.length, 2);
    f.finish(f.submissions[1], "first-run");
    await tick();
    assert.equal(f.submissions.length, 3);
    f.submissions[2].resolve({ accepted: true, disposition });
    f.finish(f.submissions[2], "second-run");
    f.finish(f.submissions[0], "owner-run");
    await phase;
    assert.equal(f.handlers.size, 0);
  });
}

test("the submission pump retains FIFO across native rejection and several outstanding outcomes", async () => {
  const f = fixture();
  const { phase } = await start(f);
  await deliver(f);
  await deliver(f, { ...f.correction, instructionId: "second" });
  await deliver(f, { ...f.correction, instructionId: "third" });
  assert.equal(f.submissions.length, 2, "await first native acceptance before sending second");
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  await tick();
  assert.equal(f.submissions.length, 3, "await second native acceptance before sending third");
  f.submissions[2].resolve({ accepted: false, error: "queue rejected input" });
  await tick();
  assert.equal(f.submissions.length, 4);
  assert.deepEqual(f.submissions.slice(1).map((s) => s.input.payload.messages[0].client_message_id),
    ["symphony-correction-correction", "symphony-correction-second", "symphony-correction-third"]);
  assert.deepEqual(f.statuses.filter((s) => s.id === "second").map((s) => s.status), ["failed"]);
  f.submissions[3].resolve({ accepted: true, disposition: "queued" });
  f.finish(f.submissions[1], "first-run");
  f.finish(f.submissions[3], "third-run");
  f.finish(f.submissions[0], "owner-run");
  await phase;
  assert.equal(f.handlers.size, 0);
});

test("an uncertain later submission stops every outstanding waiter and never submits the remaining queue", async () => {
  const f = fixture();
  const { phase } = await start(f);
  await deliver(f);
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  await deliver(f, { ...f.correction, instructionId: "second" });
  await deliver(f, { ...f.correction, instructionId: "third" });
  f.submissions[2].reject(new Error("native acceptance response lost"));
  await assert.rejects(phase);
  assert.equal(f.submissions.length, 3);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.target.correctionOutcomeUnresolved, true);
  assert.deepEqual(f.statuses.filter((s) => s.status === "failed").map((s) => s.id).sort(),
    ["correction", "second", "third"]);
  const before = [...f.statuses];
  f.finish(f.submissions[1], "late-first");
  f.finish(f.submissions[2], "late-second");
  assert.deepEqual(f.statuses, before);
});

for (const stopReason of ["end_turn", "requires_approval"]) {
  test(`two corrections sharing a native continuation retain separate ${stopReason} outcomes`, async () => {
    const f = fixture();
    const { phase } = await start(f);
    f.target.emitInputRequired = () => {};
    await deliver(f);
    f.submissions[1].resolve({ accepted: true, disposition: "queued" });
    await deliver(f, { ...f.correction, instructionId: "second" });
    f.submissions[2].resolve({ accepted: true, disposition: "queued" });
    await tick();
    const ids = f.submissions.map((s) => s.input.payload.messages[0].client_message_id);
    f.emit({ type: "update_loop_status", loop_status: {
      active_run_ids: ["shared-run"], client_message_ids_by_run_id: { "shared-run": ids },
    } });
    f.emit({ type: "turn_finished", run_id: "shared-run", turn_id: "continuation", stop_reason: stopReason });
    await phase;
    const expected = stopReason === "end_turn" ? "completed" : "blocked";
    assert.deepEqual(f.statuses.filter((s) => s.status === expected).map((s) => s.id).sort(), ["correction", "second"]);
    assert.equal(f.statuses.some((s) => s.status === "failed"), false);
    assert.equal(f.handlers.size, 0);
  });
}

test("a blocked terminal before acceptance prevents submission of the next ordinary input", async () => {
  const f = fixture();
  const { phase } = await start(f);
  f.target.emitInputRequired = () => {};
  await deliver(f);
  await deliver(f, { ...f.correction, instructionId: "second" });
  f.emit({ type: "update_loop_status", loop_status: {
    active_run_ids: ["first-run"], client_message_ids_by_run_id: { "first-run": ["symphony-correction-correction"] },
  } });
  f.emit({ type: "turn_finished", run_id: "first-run", stop_reason: "requires_approval" });
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  await f.target.drainPromise;
  assert.equal(f.submissions.length, 2);
  assert.deepEqual(f.statuses.filter((s) => s.id === "second").map((s) => s.status), ["failed"]);
  f.finish(f.submissions[0], "owner-run");
  await phase;
});

test("recovery remains blocked while any ordinary correction outcome is outstanding", async () => {
  const f = fixture();
  const { phase } = await start(f);
  await deliver(f);
  f.submissions[1].resolve({ accepted: true, disposition: "queued" });
  await deliver(f, { ...f.correction, instructionId: "second" });
  f.submissions[2].resolve({ accepted: true, disposition: "queued" });
  f.finish(f.submissions[1], "first-run");
  await tick();
  const result = await deliver(f, { ...f.correction, instructionId: "recovery", recovery: true });
  assert.equal(result.status, "blocked");
  assert.equal(f.submissions.length, 3);
  f.finish(f.submissions[2], "second-run");
  f.finish(f.submissions[0], "owner-run");
  await phase;
});

test("new receipts racing drain completion never strand ordinary guidance", async () => {
  for (let depth = 0; depth < 8; depth++) {
    const f = fixture();
    const { phase } = await start(f);
    await deliver(f);
    f.submissions[1].resolve({ accepted: true, disposition: "queued" });
    await tick();
    const emitStatus = f.target.emitStatus;
    let nextReceipt;
    f.target.emitStatus = (item, status, extra) => {
      emitStatus(item, status, extra);
      if (item.instructionId !== "correction" || status !== "completed") return;
      nextReceipt = (async () => {
        for (let index = 0; index < depth; index++) await Promise.resolve();
        return deliver(f, { ...f.correction, instructionId: "second" });
      })();
    };
    f.finish(f.submissions[1], "first-run");
    await tick();
    assert.equal((await nextReceipt).status, "received");
    assert.equal(f.submissions.length, 3, `receipt at completion microtask depth ${depth}`);
    f.submissions[2].resolve({ accepted: true, disposition: "queued" });
    f.finish(f.submissions[2], "second-run");
    f.finish(f.submissions[0], "owner-run");
    await phase;
    assert.equal(f.handlers.size, 0);
  }
});

for (const middleRejected of [false, true]) {
  test(`queued corrections track active predecessor progress${middleRejected ? " across a rejected middle input" : " through several queued inputs"}`, async () => {
    const f = fixture();
    const seen = new Set();
    const submit = (client, runtime, text, turnId, totals, hooks) =>
      bridge.submitAndWaitForTurn(client, runtime, text, turnId, totals, {
        ...hooks, turnTimeoutMs: hooks.clientMessageId === "symphony-correction-correction" ? 500 : 60,
      });
    const enqueue = async (instructionId) => {
      const item = { ...f.correction, instructionId };
      assert.equal((await bridge.acceptCorrectionForTarget(f.target, item, seen)).status, "received");
      const drain = bridge.drainCorrections(f.target, usage(), submit);
      await tick();
      return { drain };
    };
    const { drain } = await enqueue("correction");
    f.submissions[0].resolve({ accepted: true, disposition: "started" });
    f.emit({ type: "update_loop_status", loop_status: {
      active_run_ids: ["first-run"], client_message_ids_by_run_id: { "first-run": ["symphony-correction-correction"] },
    } });
    await enqueue("second");
    f.submissions[1].resolve(middleRejected
      ? { accepted: false, error: "queue rejected input" }
      : { accepted: true, disposition: "queued" });
    await tick();
    await enqueue("third");
    f.submissions[2].resolve({ accepted: true, disposition: "queued" });
    const activity = setInterval(() => f.emit({ type: "stream_delta", delta: {
      run_id: "first-run", type: "reasoning_delta", reasoning: "Still executing the first correction",
    } }), 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 160));
      assert.equal(f.target.correctionOutcomeUnresolved, undefined,
        "the exact active predecessor must keep all later queue waiters alive");
      assert.deepEqual(f.statuses.filter((s) => s.status === "failed").map((s) => s.id), middleRejected ? ["second"] : []);
      f.finish(f.submissions[0], "first-run");
      if (!middleRejected) f.finish(f.submissions[1], "second-run");
      f.finish(f.submissions[2], "third-run");
      assert.deepEqual(await drain, { outcomeUnresolved: false });
      assert.equal(f.handlers.size, 0);
    } finally {
      clearInterval(activity);
      f.target.stopCorrectionWait?.(new Error("test cleanup"));
      await drain;
    }
  });
}

test("predecessor queue-wait tracking never refreshes from an unrelated run", async () => {
  const f = fixture();
  const waiting = bridge.submitAndWaitForTurn(f.client, f.runtime, "Correction", "turn", usage(), {
    clientMessageId: "symphony-correction-correction", turnTimeoutMs: 50,
    waitingOnPredecessors: [{ clientMessageId: "earlier-message", runId: "earlier-run" }],
  });
  waiting.catch(() => {});
  f.submissions[0].resolve({ accepted: true, disposition: "queued" });
  const activity = setInterval(() => f.emit({ type: "stream_delta", delta: {
    run_id: "unrelated-run", type: "reasoning_delta", reasoning: "Unrelated activity",
  } }), 10);
  try {
    await assert.rejects(waiting, (error) => error.correctionOutcomeUnresolved === true);
    assert.equal(f.handlers.size, 0);
  } finally {
    clearInterval(activity);
  }
});

test("a queued predecessor without a known run cannot turn runless events into progress", () => {
  const context = { clientMessageId: "predecessor", correctionRunId: null, runIdsByToolCallId: new Map() };
  for (const message of [
    { type: "stream_delta", delta: { message_type: "user_message", content: "Uncorrelated echo" } },
    { type: "turn_finished", stop_reason: "end_turn" },
    { type: "external_tool_call_request", tool_call_id: "unknown" },
  ]) {
    assert.equal(bridge.isTurnActivityMessage(message, context), false);
  }
  assert.equal(bridge.isTurnActivityMessage({ type: "update_queue", removed: [
    { client_message_id: "predecessor", disposition: "dequeued" },
  ] }, context), true);
});
