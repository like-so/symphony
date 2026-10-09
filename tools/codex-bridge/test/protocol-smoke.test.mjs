import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { bridgeTestHooks } from "../bin/codex-bridge.mjs";

test("forwards real compaction boundaries and throttled progress without content", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(JSON.parse(String(chunk))); return true; };
  const send = (phase) => bridgeTestHooks.forwardStreamDelta("compaction-test", {
    message_type: "event_message", event_type: "compaction_activity",
    event_data: { phase, trigger: "private context must not be forwarded" },
  }, {});
  try {
    send("unknown");
    assert.equal(writes.length, 0);
    send("start");
    send("progress");
    assert.equal(writes.length, 1);
    now = 10_000;
    send("progress");
    send("end");
    send("failure");
    assert.deepEqual(writes.map((event) => event.params.phase), ["start", "progress", "end", "failure"]);
    assert.ok(writes.every((event) => event.method === "item/compaction/activity"));
    assert.ok(writes.every((event) => Object.keys(event.params).sort().join() === "phase,turnId"));
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("forwards bounded reasoning activity without private text", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    bridgeTestHooks.forwardStreamDelta("reasoning-test", {
      message_type: "reasoning_message", reasoning: "   ",
    }, {});
    assert.equal(writes.length, 0);
    for (let i = 0; i < 2; i++) {
      bridgeTestHooks.forwardStreamDelta("reasoning-test", {
        message_type: "reasoning_message", reasoning: "private test content",
      }, {});
    }
    assert.equal(writes.length, 1);
    const event = JSON.parse(writes[0]);
    assert.equal(event.method, "item/reasoning/activity");
    assert.deepEqual(event.params, { turnId: "reasoning-test" });
    assert.ok(!writes[0].includes("private test content"));
    bridgeTestHooks.forwardStreamDelta("another-turn", {
      message_type: "reasoning_message", reasoning: "private test content",
    }, {});
    assert.equal(writes.length, 2);
    now = 10_000;
    bridgeTestHooks.forwardStreamDelta("reasoning-test", {
      message_type: "reasoning_message", reasoning: "private test content",
    }, {});
    assert.equal(writes.length, 3);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("responds to Symphony initialize and thread start messages", async () => {
  const child = spawn(process.execPath, ["bin/codex-bridge.mjs"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"]
  });

  const lines = [];
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      if (line) lines.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const closed = new Promise((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });

  try {
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: process.cwd() } }) + "\n");
    await waitFor(() => lines.length >= 2, 5_000, () => stderr);

    assert.equal(lines[0].id, 1);
    assert.equal(
      lines[0].result.capabilities.symphonyCorrectionDelivery,
      true,
    );
    assert.equal(lines[1].result.thread.id, "local");
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await closed;
  }
});

test("emits progress as directly rendered Codex update text", async () => {
  const child = spawn(process.execPath, ["bin/codex-bridge.mjs", "--help"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));

  await new Promise((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });

  assert.match(stdout, /codex-bridge/);
});

test("summarizes operational meaning from command output", () => {
  assert.equal(
    bridgeTestHooks.semanticStatusFromText("failed to write bytecode: No space left on device (os error 28)"),
    "CI 디스크 부족 해결: GitHub runner dependency build 실패 확인"
  );

  assert.equal(
    bridgeTestHooks.semanticStatusFromText("remote: Repository not found. fatal: repository 'https://github.com/like-so/nautilus_trader.git/' not found"),
    "private dependency 인증 문제 해결: nautilus_trader repository 접근 실패 확인"
  );

  assert.equal(
    bridgeTestHooks.summarizeCommandStart("gh pr checks 19 --repo like-so/ohwl"),
    "PR 병합 차단 여부 확인: GitHub PR checks 조회"
  );

  assert.equal(
    bridgeTestHooks.summarizeCommandEnd({
      success: false,
      input: "gh run view 123 --log",
      output: "Cannot resolve imported module `pytest_mock`"
    }),
    "check 환경 의존성 문제 해결: unresolved import 실패 확인"
  );

  assert.equal(bridgeTestHooks.summarizeStatusMessage("tool success: exec_command"), "");
  assert.equal(bridgeTestHooks.summarizeStatusMessage("Tool success: write_stdin"), "");
  assert.equal(bridgeTestHooks.summarizeClientToolEnd("exec_command", "success"), "");
  assert.equal(bridgeTestHooks.summarizeClientToolEnd("github_api", "success"), "다음 조치 결정: GitHub 응답 해석");
  assert.equal(bridgeTestHooks.summarizeClientToolStart("exec_command"), "작업 증거 수집 또는 변경 적용: workspace 명령 실행");
  assert.equal(
    bridgeTestHooks.summarizeExternalToolCall("github_api", { path: "/repos/like-so/ohwl/pulls/19/checks" }),
    "PR 진행 상태 판단: GitHub PR/check/review 조회"
  );
  assert.equal(bridgeTestHooks.meaningfulStreamingText("Tool success: github_api"), false);

  assert.equal(bridgeTestHooks.isInputRequiredTool("AskUserQuestion"), true);
  assert.equal(bridgeTestHooks.isInputRequiredTool("functions.AskUserQuestion"), true);
  assert.equal(bridgeTestHooks.isInputRequiredTool("ask_user_question"), true);
  assert.equal(bridgeTestHooks.isInputRequiredTool("exec_command"), false);
});

test("correction binding rejects a stale owner target", () => {
  const binding = {
    issueId: "issue-1",
    issueIdentifier: "MT-1",
    threadId: "local",
    turnId: "letta-turn-1",
    sessionId: "local-letta-turn-1",
    workspacePath: "/workspaces/MT-1",
    workerPid: "4242",
    workerHost: null,
  };

  const correction = {
    instructionId: "instruction-1",
    issueId: "issue-1",
    issueIdentifier: "MT-1",
    threadId: "local",
    expectedTurnId: "letta-turn-1",
    sessionId: "local-letta-turn-1",
    workspacePath: "/workspaces/MT-1",
    workerPid: "4242",
    workerHost: null,
    text: "Apply the authorized correction.",
  };

  assert.equal(
    bridgeTestHooks.correctionBindingMatches(correction, binding),
    true,
  );
  assert.equal(
    bridgeTestHooks.correctionBindingMatches(
      { ...correction, sessionId: "local-letta-turn-old" },
      binding,
    ),
    false,
  );
});

test("correction receipt, execution start, and completion remain distinct", async () => {
  const correction = {
    instructionId: "instruction-2",
    issueId: "issue-2",
    issueIdentifier: "MT-2",
    threadId: "local",
    expectedTurnId: "letta-turn-2",
    sessionId: "local-letta-turn-2",
    workspacePath: "/workspaces/MT-2",
    workerPid: "5252",
    workerHost: null,
    text: "Apply the authorized correction.",
  };
  const statuses = [
    bridgeTestHooks.correctionStatus(correction, "received"),
  ];
  const target = {
    client: {},
    runtime: {},
    turnId: "letta-turn-2",
    queue: [correction],
    emitStatus: (item, status, extra) =>
      statuses.push(
        bridgeTestHooks.correctionStatus(item, status, extra),
      ),
  };

  const submitTurn = async (_client, _runtime, _text, _turnId, _usage, hooks) => {
    hooks.onAccepted({ accepted: true, disposition: "queued" });
    hooks.onExecutionStarted("run-correction-2");
    return {
      stopReason: "end_turn",
      runId: "run-correction-2",
      turnId: "turn-correction-2",
      text: "revision abc",
    };
  };

  await bridgeTestHooks.drainCorrections(
    target,
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    submitTurn,
  );

  assert.deepEqual(
    statuses.map((status) => status.status),
    ["received", "delivered", "execution_started", "completed"],
  );
  assert.equal(statuses[3].result, "revision abc");
  assert.equal(statuses[3].runId, "run-correction-2");
});

test("correction completion rejects non-success terminal outcomes", () => {
  assert.equal(
    bridgeTestHooks.correctionCompletionError({ stopReason: "end_turn" }),
    null,
  );
  assert.equal(
    bridgeTestHooks.correctionCompletionError({
      stopReason: "llm_api_error",
      error: "provider rejected the request",
    }),
    "provider rejected the request",
  );
  assert.equal(
    bridgeTestHooks.correctionCompletionError({ stopReason: "cancelled" }),
    "correction turn ended with stop reason cancelled",
  );
});

test("a correction blocking after output exhaustion preserves blocked completion", async () => {
  const target = {
    client: {}, runtime: {}, turnId: "output-limit-late-block", accepting: true, queue: [],
    emitStatus: () => {},
  };
  let submissions = 0;
  const terminal = await bridgeTestHooks.submitWorkflowPhase(target, "original task", {}, async () => {
    submissions += 1;
    target.queue.push({ instructionId: "late-block", text: "correction" });
    bridgeTestHooks.drainCorrections(target, {}, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { stopReason: "requires_approval", runId: "blocked-correction" };
    });
    return { stopReason: "max_tokens_exceeded" };
  });
  assert.equal(terminal.stopReason, "max_tokens_exceeded");
  assert.equal(submissions, 1);
  assert.equal(target.accepting, false);
});

test("owner output limit continues on the same runtime with a fresh input identity", async () => {
  const target = {
    client: {}, runtime: {}, turnId: "output-limit-resume", accepting: true, queue: [],
    emitStatus: () => assert.fail("output exhaustion must not fail queued work"),
  };
  const inputs = [];
  let completedSteps = 0;
  const terminal = await bridgeTestHooks.submitWorkflowPhase(target, "original task", {},
    async (client, runtime, prompt, turnId, usage, hooks) => {
      assert.equal(client, target.client);
      assert.equal(runtime, target.runtime);
      assert.equal(turnId, target.turnId);
      inputs.push(hooks.clientMessageId);
      if (inputs.length === 1) {
        const limit = { stopReason: "max_tokens_exceeded", error: "Unexpected stop reason: max_tokens_exceeded" };
        hooks.onTerminal(limit);
        assert.equal(target.accepting, true);
        return limit;
      }
      assert.match(prompt, /do not repeat completed operations/);
      completedSteps += 1;
      return { stopReason: "end_turn", text: "next step completed" };
    });
  assert.equal(terminal.stopReason, "end_turn");
  assert.equal(completedSteps, 1);
  assert.equal(inputs.length, 2);
  assert.notEqual(inputs[0], inputs[1]);
  assert.equal(target.accepting, true);
});

test("repeated owner output limits stop after bounded same-conversation recovery", async () => {
  const target = { client: {}, runtime: {}, turnId: "output-limit-exhausted", accepting: true, queue: [] };
  let submissions = 0;
  const terminal = await bridgeTestHooks.submitWorkflowPhase(target, "original task", {}, async () => {
    submissions += 1;
    return { stopReason: "max_tokens_exceeded" };
  });
  assert.equal(submissions, 3);
  assert.equal(terminal.stopReason, "max_tokens_exceeded");
  assert.equal(target.accepting, false);
});

test("output-limit continuation respects unresolved correction outcomes", async () => {
  const target = { client: {}, runtime: {}, turnId: "output-limit-unresolved", accepting: true, queue: [] };
  let submissions = 0;
  await assert.rejects(bridgeTestHooks.submitWorkflowPhase(target, "original task", {}, async () => {
    submissions += 1;
    target.correctionOutcomeUnresolved = true;
    return { stopReason: "max_tokens_exceeded" };
  }), /Correction terminal outcome is unresolved/);
  assert.equal(submissions, 1);
});

for (const outcome of ["llm_api_error", "cancelled", "timeout"]) {
  test(`a ${outcome} phase fails queued corrections without submitting them`, async () => {
    const statuses = [];
    const correction = { instructionId: `queued-${outcome}` };
    const target = {
      client: {}, runtime: {}, turnId: "phase-1", accepting: true, queue: [],
      emitStatus: (item, status, extra) => statuses.push({ item, status, ...extra }),
    };
    let submissions = 0;
    const submit = async () => {
      submissions += 1;
      target.queue.push(correction);
      if (outcome === "timeout") throw new Error("phase timed out");
      return { stopReason: outcome };
    };

    await assert.rejects(bridgeTestHooks.submitWorkflowPhase(
      target, "original phase", {}, submit,
    ));
    assert.equal(submissions, 1);
    assert.equal(target.accepting, false);
    assert.deepEqual(target.queue, []);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].item, correction);
    assert.equal(statuses[0].status, "failed");
    assert.equal(statuses[0].runId, undefined);
  });
}

test("successful phase preserves queued corrections for the existing drain", async () => {
  const correction = { instructionId: "queued-success" };
  const target = {
    client: {}, runtime: {}, turnId: "phase-1", accepting: true, queue: [],
    emitStatus: () => assert.fail("successful phase must not fail the queue"),
  };
  const terminal = await bridgeTestHooks.submitWorkflowPhase(
    target, "original phase", {}, async () => {
      target.queue.push(correction);
      return { stopReason: "end_turn", text: "finished" };
    },
  );
  assert.equal(terminal.stopReason, "end_turn");
  assert.equal(target.accepting, true);
  assert.deepEqual(target.queue, [correction]);
});

test("queued correction execution is correlated by client message id", () => {
  const message = {
    type: "update_queue",
    removed: [
      { client_message_id: "other", disposition: "dequeued" },
      {
        client_message_id: "symphony-correction-instruction-3",
        disposition: "dequeued",
      },
    ],
  };

  assert.equal(
    bridgeTestHooks.queueDispositionForMessage(
      message,
      "symphony-correction-instruction-3",
    ),
    "dequeued",
  );
  assert.equal(
    bridgeTestHooks.queueDispositionForMessage(message, "missing"),
    null,
  );

  const loopStatus = {
    type: "update_loop_status",
    loop_status: {
      active_run_ids: ["run-correction-3"],
      client_message_ids_by_run_id: {
        "run-other": ["other"],
        "run-correction-3": ["symphony-correction-instruction-3"],
      },
    },
  };

  assert.equal(
    bridgeTestHooks.correctionRunIdForMessage(
      loopStatus,
      "symphony-correction-instruction-3",
    ),
    "run-correction-3",
  );
  assert.equal(
    bridgeTestHooks.correctionRunIdForMessage(loopStatus, "missing"),
    null,
  );

  assert.equal(
    bridgeTestHooks.correctionRunIdForMessage(
      {
        ...loopStatus,
        loop_status: {
          ...loopStatus.loop_status,
          active_run_ids: ["run-other"],
        },
      },
      "symphony-correction-instruction-3",
    ),
    "run-correction-3",
  );

  assert.equal(
    bridgeTestHooks.correctionRunIdForMessage(
      {
        ...loopStatus,
        loop_status: {
          active_run_ids: ["run-correction-3", "run-duplicate"],
          client_message_ids_by_run_id: {
            ...loopStatus.loop_status.client_message_ids_by_run_id,
            "run-duplicate": ["symphony-correction-instruction-3"],
          },
        },
      },
      "symphony-correction-instruction-3",
    ),
    null,
  );

  assert.equal(
    bridgeTestHooks.correctionRunIdForMessage(
      {
        ...loopStatus,
        loop_status: {
          active_run_ids: ["run-duplicate"],
          client_message_ids_by_run_id: {
            ...loopStatus.loop_status.client_message_ids_by_run_id,
            "run-duplicate": ["symphony-correction-instruction-3"],
          },
        },
      },
      "symphony-correction-instruction-3",
      "run-correction-3",
    ),
    "run-duplicate",
  );
});

test("owner phase ignores another input's terminal before its own correlation arrives", async () => {
  const runtime = { agent_id: "agent-owner", conversation_id: "conversation-owner" };
  let receive;
  const client = {
    onMessage: (handler) => { receive = handler; return () => {}; },
    submitInput: async (command) => {
      const messageId = command.payload.messages[0].client_message_id;
      queueMicrotask(() => {
        for (const runId of ["another-input", "owner-input"]) {
          receive({
            type: "turn_finished", runtime, run_id: runId,
            turn_id: runId, stop_reason: "end_turn",
          });
        }
        receive({
          type: "update_loop_status", runtime,
          loop_status: {
            active_run_ids: [],
            client_message_ids_by_run_id: { "owner-input": [messageId] },
          },
        });
      });
      return { accepted: true, disposition: "started" };
    },
    waitForClose: () => new Promise(() => {}),
  };
  const target = {
    client, runtime, turnId: "owner-phase", accepting: true, queue: [],
    emitStatus: () => assert.fail("no correction was submitted"),
  };
  const terminal = await bridgeTestHooks.submitWorkflowPhase(
    target, "Perform the owner phase", { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  );
  assert.equal(terminal.runId, "owner-input");
  assert.equal(terminal.turnId, "owner-input");
});

test("correction waits for the correlated run terminal", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  let onMessage;
  let resolveClose;
  const client = {
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    submitInput: async () => {
      queueMicrotask(() => {
        onMessage({
          type: "turn_finished",
          runtime,
          run_id: "run-unrelated",
          turn_id: "turn-unrelated",
          stop_reason: "end_turn",
        });
        onMessage({
          type: "turn_finished",
          runtime,
          run_id: "run-correction",
          turn_id: "turn-correction",
          stop_reason: "end_turn",
        });
        onMessage({
          type: "update_loop_status",
          runtime,
          loop_status: {
            active_run_ids: [],
            client_message_ids_by_run_id: {
              "run-correction": ["symphony-correction-instruction-terminal"],
            },
          },
        });
      });
      return { accepted: true, disposition: "started" };
    },
    waitForClose: () => new Promise((resolve) => {
      resolveClose = resolve;
    }),
  };
  const startedRuns = [];

  const terminal = await bridgeTestHooks.submitAndWaitForTurn(
    client,
    runtime,
    "Apply the authorized correction.",
    "letta-turn-terminal",
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    {
      clientMessageId: "symphony-correction-instruction-terminal",
      onExecutionStarted: (runId) => startedRuns.push(runId),
    },
  );

  assert.deepEqual(startedRuns, ["run-correction"]);
  assert.equal(terminal.runId, "run-correction");
  assert.equal(terminal.turnId, "turn-correction");
  resolveClose?.();
});

test("correction follows its client message into a continuation run", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  let onMessage;
  let resolveClose;
  const client = {
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    submitInput: async () => {
      queueMicrotask(() => {
        onMessage({
          type: "update_loop_status",
          runtime,
          loop_status: {
            active_run_ids: ["run-initial"],
            client_message_ids_by_run_id: {
              "run-initial": ["symphony-correction-instruction-continuation"],
            },
          },
        });
        onMessage({
          type: "stream_delta",
          runtime,
          delta: {
            type: "message",
            message_type: "assistant_message",
            run_id: "run-continuation",
            content: "Continued result",
          },
        });
        onMessage({
          type: "turn_finished",
          runtime,
          run_id: "run-continuation",
          turn_id: "turn-continuation",
          stop_reason: "end_turn",
        });
        onMessage({
          type: "update_loop_status",
          runtime,
          loop_status: {
            active_run_ids: [],
            client_message_ids_by_run_id: {
              "run-initial": ["symphony-correction-instruction-continuation"],
              "run-continuation": ["symphony-correction-instruction-continuation"],
            },
          },
        });
      });
      return { accepted: true, disposition: "started" };
    },
    waitForClose: () =>
      new Promise((resolve) => {
        resolveClose = resolve;
      }),
  };

  const terminal = await bridgeTestHooks.submitAndWaitForTurn(
    client,
    runtime,
    "Apply the authorized correction.",
    "letta-turn-continuation",
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    { clientMessageId: "symphony-correction-instruction-continuation" },
  );

  assert.equal(terminal.runId, "run-continuation");
  assert.equal(terminal.turnId, "turn-continuation");
  assert.equal(terminal.stopReason, "end_turn");
  assert.equal(terminal.text, "Continued result");
  resolveClose?.();
});

test("correction preserves an earlier input request until its tool run is known", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  let onMessage;
  let resolveClose;
  const client = {
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    submitInput: async () => {
      queueMicrotask(() => {
        onMessage({
          type: "update_loop_status",
          runtime,
          loop_status: {
            active_run_ids: ["run-correction"],
            client_message_ids_by_run_id: {
              "run-correction": ["symphony-correction-instruction-reordered-input"],
            },
          },
        });
        onMessage({
          type: "external_tool_call_request",
          runtime,
          request_id: "request-correction",
          tool_call_id: "tool-correction",
          tool_name: "AskUserQuestion",
          input: { question: "Correction question?" },
        });
        onMessage({
          type: "turn_finished",
          runtime,
          run_id: "run-correction",
          turn_id: "turn-correction",
          stop_reason: "end_turn",
        });
        onMessage({
          type: "stream_delta",
          runtime,
          delta: {
            message_type: "client_tool_start",
            run_id: "run-correction",
            tool_call_id: "tool-correction",
          },
        });
      });
      return { accepted: true, disposition: "started" };
    },
    waitForClose: () =>
      new Promise((resolve) => {
        resolveClose = resolve;
      }),
  };

  const terminal = await bridgeTestHooks.submitAndWaitForTurn(
    client,
    runtime,
    "Apply the authorized correction.",
    "letta-turn-reordered-input",
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    { clientMessageId: "symphony-correction-instruction-reordered-input" },
  );

  assert.equal(terminal.stopReason, "input_required");
  assert.equal(terminal.runId, "run-correction");
  assert.equal(terminal.blocker.reason, "Correction question?");
  resolveClose?.();
});

test("correction blocks only for input required by its correlated run", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  let onMessage;
  let resolveClose;
  const client = {
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    submitInput: async () => {
      queueMicrotask(() => {
        onMessage({
          type: "stream_delta",
          runtime,
          delta: {
            message_type: "client_tool_start",
            run_id: "run-unrelated",
            tool_call_id: "tool-unrelated",
          },
        });
        onMessage({
          type: "external_tool_call_request",
          runtime,
          request_id: "request-unrelated",
          tool_call_id: "tool-unrelated",
          tool_name: "AskUserQuestion",
          input: { question: "Unrelated question?" },
        });
        onMessage({
          type: "stream_delta",
          runtime,
          delta: {
            message_type: "client_tool_start",
            run_id: "run-correction",
            tool_call_id: "tool-correction",
          },
        });
        onMessage({
          type: "external_tool_call_request",
          runtime,
          request_id: "request-correction",
          tool_call_id: "tool-correction",
          tool_name: "AskUserQuestion",
          input: { question: "Correction question?" },
        });
        onMessage({
          type: "update_loop_status",
          runtime,
          loop_status: {
            active_run_ids: ["run-correction"],
            client_message_ids_by_run_id: {
              "run-correction": ["symphony-correction-instruction-input"],
            },
          },
        });
      });
      return { accepted: true, disposition: "started" };
    },
    waitForClose: () =>
      new Promise((resolve) => {
        resolveClose = resolve;
      }),
  };

  const terminal = await bridgeTestHooks.submitAndWaitForTurn(
    client,
    runtime,
    "Apply the authorized correction.",
    "letta-turn-input",
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    { clientMessageId: "symphony-correction-instruction-input" },
  );

  assert.equal(terminal.stopReason, "input_required");
  assert.equal(terminal.runId, "run-correction");
  assert.equal(terminal.blocker.reason, "Correction question?");
  resolveClose?.();
});

test("correction blocks only for approval required by its correlated run", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  let onMessage;
  let resolveClose;
  const client = {
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    submitInput: async () => {
      queueMicrotask(() => {
        onMessage({
          type: "control_request",
          runtime,
          request_id: "approval-unrelated",
          request: {
            subtype: "can_use_tool",
            tool_name: "exec_command",
            tool_call_id: "tool-unrelated",
            input: {},
          },
        });
        onMessage({
          type: "stream_delta",
          runtime,
          delta: {
            type: "message",
            message_type: "approval_request_message",
            run_id: "run-unrelated",
            tool_call: {
              tool_call_id: "tool-unrelated",
              name: "exec_command",
              arguments: "{}",
            },
          },
        });
        onMessage({
          type: "control_request",
          runtime,
          request_id: "approval-correction",
          request: {
            subtype: "can_use_tool",
            tool_name: "exec_command",
            tool_call_id: "tool-correction",
            input: {},
          },
        });
        onMessage({
          type: "stream_delta",
          runtime,
          delta: {
            type: "message",
            message_type: "approval_request_message",
            run_id: "run-correction",
            tool_calls: [],
            tool_call: {
              tool_call_id: "tool-correction",
              name: "exec_command",
              arguments: "{}",
            },
          },
        });
        onMessage({
          type: "update_loop_status",
          runtime,
          loop_status: {
            active_run_ids: ["run-correction"],
            client_message_ids_by_run_id: {
              "run-correction": ["symphony-correction-instruction-approval"],
            },
          },
        });
      });
      return { accepted: true, disposition: "started" };
    },
    waitForClose: () =>
      new Promise((resolve) => {
        resolveClose = resolve;
      }),
  };

  const terminal = await bridgeTestHooks.submitAndWaitForTurn(
    client,
    runtime,
    "Apply the authorized correction.",
    "letta-turn-approval",
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    { clientMessageId: "symphony-correction-instruction-approval" },
  );

  assert.equal(terminal.stopReason, "requires_approval");
  assert.equal(terminal.runId, "run-correction");
  assert.equal(
    terminal.blocker.reason,
    "exec_command requires operator approval",
  );
  resolveClose?.();
});

test("correction reports interactive approval tools as operator input", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  let onMessage;
  let resolveClose;
  const client = {
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    submitInput: async () => {
      queueMicrotask(() => {
        onMessage({
          type: "update_loop_status",
          runtime,
          loop_status: {
            active_run_ids: ["run-correction"],
            client_message_ids_by_run_id: {
              "run-correction": ["symphony-correction-instruction-question"],
            },
          },
        });
        onMessage({
          type: "stream_delta",
          runtime,
          delta: {
            type: "message",
            message_type: "approval_request_message",
            run_id: "run-correction",
            tool_calls: [
              {
                tool_call_id: "tool-correction",
                name: "AskUserQuestion",
                arguments:
                  '{"questions":[{"question":"Which correction path should continue?"}]}',
              },
            ],
          },
        });
        onMessage({
          type: "control_request",
          runtime,
          request_id: "input-correction",
          request: {
            subtype: "can_use_tool",
            tool_name: "AskUserQuestion",
            tool_call_id: "tool-correction",
            input: {
              questions: [{ question: "Which correction path should continue?" }],
            },
            permission_suggestions: [],
            blocked_path: null,
          },
        });
      });
      return { accepted: true, disposition: "started" };
    },
    waitForClose: () =>
      new Promise((resolve) => {
        resolveClose = resolve;
      }),
  };

  const terminal = await bridgeTestHooks.submitAndWaitForTurn(
    client,
    runtime,
    "Apply the authorized correction.",
    "letta-turn-question",
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    { clientMessageId: "symphony-correction-instruction-question" },
  );

  assert.equal(terminal.stopReason, "input_required");
  assert.equal(terminal.runId, "run-correction");
  assert.equal(
    terminal.blocker.reason,
    "Which correction path should continue?",
  );
  assert.equal(terminal.blocker.remainingScope, "operator input");
  resolveClose?.();
});

test("input-required correction is blocked and later queued work is failed", async () => {
  const corrections = ["blocked", "queued"].map((suffix) => ({
    instructionId: `instruction-${suffix}`,
    issueId: "issue-blocked",
    issueIdentifier: "MT-BLOCKED",
    threadId: "local",
    expectedTurnId: "letta-turn-blocked",
    sessionId: "local-letta-turn-blocked",
    workspacePath: "/workspaces/MT-BLOCKED",
    workerPid: "6262",
    workerHost: null,
    text: "Apply the authorized correction.",
  }));
  const statuses = [];
  const lifecycle = [];
  const target = {
    client: {},
    runtime: {},
    turnId: "letta-turn-blocked",
    accepting: true,
    queue: [...corrections],
    emitStatus: (item, status, extra) => {
      statuses.push({ instructionId: item.instructionId, status, ...extra });
      lifecycle.push(status);
    },
    emitInputRequired: () => lifecycle.push("owner_input_required"),
  };

  await bridgeTestHooks.drainCorrections(
    target,
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    async (_client, _runtime, _text, _turnId, _usage, hooks) => {
      hooks.onAccepted({ accepted: true, disposition: "started" });
      hooks.onExecutionStarted("run-blocked");
      return {
        stopReason: "input_required",
        runId: "run-blocked",
        blocker: "Operator input is required.",
        text: "",
      };
    },
  );

  assert.deepEqual(
    statuses.map(({ instructionId, status }) => [instructionId, status]),
    [
      ["instruction-blocked", "delivered"],
      ["instruction-blocked", "execution_started"],
      ["instruction-blocked", "blocked"],
      ["instruction-queued", "failed"],
    ],
  );
  assert.equal(target.accepting, false);
  assert.deepEqual(lifecycle, [
    "delivered",
    "execution_started",
    "blocked",
    "failed",
    "owner_input_required",
  ]);
});

test("approval-required correction terminal is blocked", async () => {
  const correction = {
    instructionId: "instruction-approval-terminal",
    issueId: "issue-approval-terminal",
    issueIdentifier: "MT-APPROVAL",
    threadId: "local",
    expectedTurnId: "letta-turn-approval-terminal",
    sessionId: "local-letta-turn-approval-terminal",
    workspacePath: "/workspaces/MT-APPROVAL",
    workerPid: "6363",
    workerHost: null,
    text: "Apply the authorized correction.",
  };
  const statuses = [];
  const target = {
    client: {},
    runtime: {},
    turnId: "letta-turn-approval-terminal",
    accepting: true,
    queue: [correction],
    emitStatus: (item, status, extra) =>
      statuses.push({ instructionId: item.instructionId, status, ...extra }),
    emitInputRequired: () => {},
  };

  await bridgeTestHooks.drainCorrections(
    target,
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    async (_client, _runtime, _text, _turnId, _usage, hooks) => {
      hooks.onAccepted({ accepted: true, disposition: "started" });
      hooks.onExecutionStarted("run-approval-terminal");
      return {
        stopReason: "requires_approval",
        runId: "run-approval-terminal",
        text: "",
      };
    },
  );

  assert.deepEqual(
    statuses.map(({ status }) => status),
    ["delivered", "execution_started", "blocked"],
  );
  assert.match(statuses[2].error, /requires operator approval/);
  assert.equal(target.accepting, false);
});

test("accepted correction transport loss is marked unresolved", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  const client = {
    onMessage: () => () => {},
    submitInput: async () => ({ accepted: true, disposition: "queued" }),
    waitForClose: () =>
      Promise.reject(new Error("Letta App Server WebSocket closed")),
  };

  await assert.rejects(
    bridgeTestHooks.submitAndWaitForTurn(
      client,
      runtime,
      "Apply the authorized correction.",
      "letta-turn-unresolved",
      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      { clientMessageId: "symphony-correction-instruction-unresolved" },
    ),
    (error) => {
      assert.equal(error.correctionOutcomeUnresolved, true);
      assert.match(error.message, /terminal outcome is unresolved/);
      return true;
    },
  );
});

test("active correction activity extends the terminal wait", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  const clientMessageId = "symphony-correction-instruction-active";
  let onMessage;
  let resolveClose;
  const client = {
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    submitInput: async () => {
      setTimeout(() => {
        onMessage({
          type: "update_loop_status",
          runtime,
          loop_status: {
            active_run_ids: ["run-correction"],
            client_message_ids_by_run_id: {
              "run-correction": [clientMessageId],
            },
          },
        });
      }, 20);
      setTimeout(() => {
        onMessage({
          type: "stream_delta",
          runtime,
          delta: {
            type: "message",
            message_type: "assistant_message",
            run_id: "run-correction",
            content: "Still working",
          },
        });
      }, 50);
      setTimeout(() => {
        onMessage({
          type: "turn_finished",
          runtime,
          run_id: "run-correction",
          turn_id: "turn-correction",
          stop_reason: "end_turn",
        });
      }, 80);
      return { accepted: true, disposition: "started" };
    },
    waitForClose: () =>
      new Promise((resolve) => {
        resolveClose = resolve;
      }),
  };

  const terminal = await bridgeTestHooks.submitAndWaitForTurn(
    client,
    runtime,
    "Apply the authorized correction.",
    "letta-turn-active",
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    { clientMessageId, turnTimeoutMs: 40 },
  );

  assert.equal(terminal.runId, "run-correction");
  assert.equal(terminal.turnId, "turn-correction");
  assert.equal(terminal.stopReason, "end_turn");
  assert.equal(terminal.text, "Still working");
  resolveClose?.();
});

test("correction activity excludes unrelated same-runtime events", () => {
  const clientMessageId = "symphony-correction-instruction-stalled";
  const context = {
    clientMessageId,
    correctionRunId: "run-correction",
    runIdsByToolCallId: new Map([
      ["tool-correction", "run-correction"],
      ["tool-unrelated", "run-unrelated"],
    ]),
  };

  assert.equal(
    bridgeTestHooks.isTurnActivityMessage(
      { type: "stream_delta", delta: { run_id: "run-unrelated" } },
      context,
    ),
    false,
  );
  assert.equal(
    bridgeTestHooks.isTurnActivityMessage(
      {
        type: "update_loop_status",
        loop_status: {
          active_run_ids: ["run-unrelated"],
          client_message_ids_by_run_id: {
            "run-unrelated": ["another-message"],
          },
        },
      },
      context,
    ),
    false,
  );
  assert.equal(
    bridgeTestHooks.isTurnActivityMessage(
      {
        type: "update_queue",
        removed: [{ client_message_id: "another-message" }],
      },
      context,
    ),
    false,
  );
  assert.equal(
    bridgeTestHooks.isTurnActivityMessage(
      {
        type: "external_tool_call_request",
        tool_call_id: "tool-unrelated",
      },
      context,
    ),
    false,
  );
  assert.equal(
    bridgeTestHooks.isTurnActivityMessage(
      { type: "stream_delta", delta: { run_id: "run-correction" } },
      context,
    ),
    true,
  );
  assert.equal(
    bridgeTestHooks.isTurnActivityMessage(
      {
        type: "update_loop_status",
        loop_status: {
          active_run_ids: ["run-correction"],
          client_message_ids_by_run_id: {
            "run-correction": [clientMessageId],
          },
        },
      },
      context,
    ),
    true,
  );
});

test("unrelated activity does not extend a stalled correction wait", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  const clientMessageId = "symphony-correction-instruction-idle";
  let onMessage;
  let correctionStatusTimer;
  let correctionStarted = false;
  let unrelatedEventCount = 0;
  let unrelatedTimer;
  const client = {
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    submitInput: async () => {
      correctionStatusTimer = setTimeout(() => {
        onMessage({
          type: "update_loop_status",
          runtime,
          loop_status: {
            active_run_ids: ["run-correction"],
            client_message_ids_by_run_id: {
              "run-correction": [clientMessageId],
            },
          },
        });
      }, 20);
      unrelatedTimer = setInterval(() => {
        unrelatedEventCount += 1;
        onMessage({
          type: "stream_delta",
          runtime,
          delta: {
            type: "message",
            message_type: "assistant_message",
            run_id: "run-unrelated",
            content: "Unrelated activity",
          },
        });
      }, 20);
      return { accepted: true, disposition: "started" };
    },
    waitForClose: () => new Promise(() => {}),
  };

  let assertionDeadline;
  try {
    await Promise.race([
      assert.rejects(
        bridgeTestHooks.submitAndWaitForTurn(
          client,
          runtime,
          "Apply the authorized correction.",
          "letta-turn-idle",
          { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          {
            clientMessageId,
            turnTimeoutMs: 60,
            onExecutionStarted: () => {
              correctionStarted = true;
            },
          },
        ),
        (error) => {
          assert.equal(error.correctionOutcomeUnresolved, true);
          assert.match(
            error.cause?.message,
            /Timed out waiting for Letta turn_finished/,
          );
          assert.equal(correctionStarted, true);
          assert.ok(unrelatedEventCount > 0);
          return true;
        },
      ),
      new Promise((_, reject) => {
        assertionDeadline = setTimeout(
          () => setImmediate(() =>
            reject(new Error("Unrelated activity extended the turn timeout")),
          ),
          180,
        );
      }),
    ]);
  } finally {
    clearTimeout(correctionStatusTimer);
    clearInterval(unrelatedTimer);
    clearTimeout(assertionDeadline);
  }
});

test("correction acceptance timeout is marked unresolved", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  const client = {
    onMessage: () => () => {},
    submitInput: async () => {
      throw new Error("Timed out waiting for input-1");
    },
    waitForClose: () => new Promise(() => {}),
  };

  await assert.rejects(
    bridgeTestHooks.submitAndWaitForTurn(
      client,
      runtime,
      "Apply the authorized correction.",
      "letta-turn-acceptance-timeout",
      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      { clientMessageId: "symphony-correction-instruction-timeout" },
    ),
    (error) => {
      assert.equal(error.correctionOutcomeUnresolved, true);
      assert.match(error.message, /may have been accepted/);
      return true;
    },
  );
});

test("correlated terminal survives a missing acceptance response", async () => {
  const runtime = { agent_id: "agent-1", conversation_id: "conversation-1" };
  let onMessage;
  const client = {
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    submitInput: async () => {
      queueMicrotask(() => {
        onMessage({
          type: "update_loop_status",
          runtime,
          loop_status: {
            active_run_ids: ["run-correction"],
            client_message_ids_by_run_id: {
              "run-correction": ["symphony-correction-instruction-terminal"],
            },
          },
        });
        onMessage({
          type: "turn_finished",
          runtime,
          run_id: "run-correction",
          turn_id: "turn-correction",
          stop_reason: "end_turn",
        });
      });
      await Promise.resolve();
      throw new Error("Timed out waiting for input-1");
    },
    waitForClose: () => new Promise(() => {}),
  };
  const startedRuns = [];

  const terminal = await bridgeTestHooks.submitAndWaitForTurn(
    client,
    runtime,
    "Apply the authorized correction.",
    "letta-turn-terminal-before-acceptance",
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    {
      clientMessageId: "symphony-correction-instruction-terminal",
      onExecutionStarted: (runId) => startedRuns.push(runId),
    },
  );

  assert.deepEqual(startedRuns, ["run-correction"]);
  assert.equal(terminal.runId, "run-correction");
  assert.equal(terminal.stopReason, "end_turn");
});

test("unresolved accepted correction stops later correction delivery", async () => {
  const corrections = ["unresolved", "later"].map((suffix) => ({
    instructionId: `instruction-${suffix}`,
    issueId: "issue-unresolved",
    issueIdentifier: "MT-UNRESOLVED",
    threadId: "local",
    expectedTurnId: "letta-turn-unresolved",
    sessionId: "local-letta-turn-unresolved",
    workspacePath: "/workspaces/MT-UNRESOLVED",
    workerPid: "7272",
    workerHost: null,
    text: "Apply the authorized correction.",
  }));
  const statuses = [];
  let submissions = 0;
  const target = {
    client: {},
    runtime: {},
    turnId: "letta-turn-unresolved",
    accepting: true,
    queue: [...corrections],
    emitStatus: (item, status, extra) =>
      statuses.push({ instructionId: item.instructionId, status, ...extra }),
  };

  const result = await bridgeTestHooks.drainCorrections(
    target,
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    async () => {
      submissions += 1;
      const error = new Error("accepted correction terminal was not observed");
      error.correctionOutcomeUnresolved = true;
      throw error;
    },
  );

  assert.equal(submissions, 1);
  assert.equal(result.outcomeUnresolved, true);
  assert.equal(target.accepting, false);
  assert.deepEqual(
    statuses.map(({ instructionId, status }) => [instructionId, status]),
    [
      ["instruction-unresolved", "failed"],
      ["instruction-later", "failed"],
    ],
  );
  assert.match(statuses[1].error, /no observed terminal outcome/);
});

function waitFor(predicate, timeoutMs, details) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for condition. ${details()}`));
      }
    }, 25);
  });
}
