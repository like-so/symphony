#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

class AppServerProcessManager {
  constructor({
    spawnProcess = spawn,
    signalProcess = signalProcessGroup,
    isProcessGroupAlive = processGroupIsAlive,
    shutdownTimeoutMs = 5_000,
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.signalProcess = signalProcess;
    this.isProcessGroupAlive = isProcessGroupAlive;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.owned = new Set();
    this.stopping = new Map();
    this.shuttingDown = false;
  }

  async start({ lettaBin, backend, listenUrl, startTimeoutMs }) {
    if (this.shuttingDown)
      throw new Error(
        "Bridge is shutting down; refusing to start a local App Server",
      );
    const args = ["server", "--backend", backend, "--listen", listenUrl];
    const child = this.spawnProcess(lettaBin, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.owned.add(child);
    child.once("error", () => {
      if (!child.pid) this.owned.delete(child);
    });

    try {
      const url = await waitForListeningUrl(child, startTimeoutMs);
      return { url, child };
    } catch (error) {
      await this.stop(child);
      throw error;
    }
  }

  stop(child) {
    if (!child || !this.owned.has(child)) return Promise.resolve();
    if (this.stopping.has(child)) return this.stopping.get(child);
    const stopping = this.stopOwned(child).finally(() =>
      this.stopping.delete(child),
    );
    this.stopping.set(child, stopping);
    return stopping;
  }

  async stopOwned(child) {
    if (!this.isProcessGroupAlive(child)) {
      this.owned.delete(child);
      return;
    }
    this.signalProcess(child, "SIGTERM");
    if (
      await waitForProcessGroupExit(
        child,
        this.shutdownTimeoutMs,
        this.isProcessGroupAlive,
      )
    ) {
      this.owned.delete(child);
      return;
    }
    this.signalProcess(child, "SIGKILL");
    if (
      !(await waitForProcessGroupExit(
        child,
        this.shutdownTimeoutMs,
        this.isProcessGroupAlive,
      ))
    ) {
      throw new Error(
        `Letta App Server process group ${child.pid || "unknown"} did not exit after SIGKILL`,
      );
    }
    this.owned.delete(child);
  }

  async stopAll() {
    this.shuttingDown = true;
    const results = await Promise.allSettled(
      [...this.owned].map((child) => this.stop(child)),
    );
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Failed to stop all Letta App Servers",
      );
  }

  killAllBestEffort() {
    for (const child of this.owned) {
      if (this.isProcessGroupAlive(child)) this.signalProcess(child, "SIGTERM");
    }
  }

  get size() {
    return this.owned.size;
  }
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (hasExited(child)) return false;
  return child.kill(signal);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function processGroupIsAlive(child) {
  if (!child?.pid) return false;
  if (process.platform === "win32") return !hasExited(child);
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function waitForProcessGroupExit(child, timeoutMs, isAlive) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (!isAlive(child)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, Math.min(10, Math.max(1, deadline - Date.now())));
    };
    check();
  });
}

const options = parseArgs(process.argv.slice(2));
const threadId = "local";
let turnCounter = 0;
let shutdownPromise = null;
let dynamicTools = [];
let activeCorrectionTarget = null;
const acceptedCorrectionIds = new Set();
const pendingSymphonyResponses = new Map();
const toolNamesById = new Map();
const lastProgressByTurn = new Map();
const blockedTurns = new Set();
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const appServers = new AppServerProcessManager({
  shutdownTimeoutMs: options.serverShutdownTimeoutMs,
});

export const bridgeTestHooks = {
  isInputRequiredTool,
  semanticStatusFromText,
  summarizeClientToolEnd,
  summarizeClientToolStart,
  summarizeCommandEnd,
  summarizeCommandStart,
  summarizeExternalToolCall,
  summarizeStatusMessage,
  meaningfulStreamingText,
  AppServerProcessManager,
  createAppServerBridgeClientForTest,
  acceptCorrectionForTarget,
  createCorrectionTarget,
  inspectRecoveryIdle,
  validateRecoveryAuthority,
  correctionBindingMatches,
  correctionCompletionError,
  correctionRunIdForMessage,
  correctionStatus,
  drainCorrections,
  queueDispositionForMessage,
  resolveAppServer,
  submitAndWaitForTurn,
  submitWorkflowPhase,
};

if (isMain) {
  startStdioBridge();
  process.once("SIGINT", () => void shutdownBridge(130));
  process.once("SIGTERM", () => void shutdownBridge(143));
  process.on("exit", () => appServers.killAllBestEffort());
}

function startStdioBridge() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", (line) => {
    handleLine(line).catch((error) => {
      emit({ method: "turn/failed", params: {
        error: formatError(error),
        ...(error.recoveryInstructionId ? {
          errorCode: "explicit_recovery_handoff",
          recoveryInstructionId: error.recoveryInstructionId,
        } : {}),
      } });
    });
  });

  rl.on("close", () => void shutdownBridge(0));
}

async function handleLine(line) {
  if (!line.trim()) return;

  const message = JSON.parse(line);
  const { id, method, params = {} } = message;

  if (!method && id !== undefined && pendingSymphonyResponses.has(id)) {
    pendingSymphonyResponses.get(id).resolve(message);
    pendingSymphonyResponses.delete(id);
    return;
  }

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "codex-bridge/0.2",
      capabilities: {
        experimentalApi: true,
        symphonyCorrectionDelivery: true,
        symphonyCorrectionRecovery: true,
      },
    });
    return;
  }

  if (method === "initialized") return;

  if (method === "thread/start") {
    dynamicTools = Array.isArray(params.dynamicTools)
      ? params.dynamicTools
      : [];
    respond(id, { thread: { id: threadId } });
    return;
  }

  if (method === "turn/start") {
    const fallbackTurnId = `letta-turn-${++turnCounter}`;
    await runLettaWorkflow(id, fallbackTurnId, params);
    return;
  }

  if (method === "symphony/correction/deliver") {
    await acceptCorrection(id, params);
    return;
  }

  respond(id, null);
}

async function runLettaWorkflow(turnStartResponseId, fallbackTurnId, params) {
  const prompt = buildPrompt(params);
  const cwd = params.cwd || process.cwd();
  let turnStarted = true;
  let turnId = fallbackTurnId;
  let ownedAppServer = null;
  let correctionTarget = null;

  try {
    // Symphony expects turn/start to be acknowledged before a runtime can be provisioned.
    respond(turnStartResponseId, { turn: { id: turnId } });
    correctionTarget = createCorrectionTarget(params, fallbackTurnId, null, null);
    activeCorrectionTarget = correctionTarget;
    const appServer = await resolveAppServer();
    ownedAppServer = appServer.child;
    const client = await AppServerBridgeClient.connect(appServer.url, {
      requestTimeoutMs: options.requestTimeoutMs,
    });

    try {
      const runtimeContext = await startRuntime(client, cwd);
      const runtime = runtimeContext.runtime;
      const conversationId = conversationIdFromRuntime(runtimeContext);
      correctionTarget.client = client;
      correctionTarget.runtime = runtime;

      emitProgress(
        turnId,
        progress(
          "Letta 작업 세션 연결",
          `conversation ${conversationId || "unknown"}`,
        ),
      );
      emitAgentMessage(
        turnId,
        `Starting Letta App Server workflow${options.agentLabel ? ` with ${options.agentLabel}` : ""}.`,
      );

      client.onMessage((message) =>
        handleExternalToolCall(client, message, turnId),
      );
      const phases = buildWorkflowPhases(prompt);
      const phaseReports = [];
      const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

      for (const phase of phases) {
        emitProgress(turnId, `phase ${phase.name}: starting`);
        const terminal = await submitWorkflowPhase(
          correctionTarget,
          phase.prompt,
          usage,
        );
        if (terminal.stopReason === "requires_approval") {
          emitInputRequired(turnId, {
            reason: "Owner turn requires operator approval",
            missing: [],
            remainingScope: "operator approval",
          });
          emitBlockedCompletion(turnId, usage);
          return;
        }
        if (blockedTurns.has(turnId)) {
          emitBlockedCompletion(turnId, usage);
          return;
        }
        phaseReports.push(
          `## ${phase.name}\n${terminal.text || "Completed."}`,
        );
        emitProgress(turnId, `phase ${phase.name}: completed`);
        const correctionDrain = await drainCorrections(correctionTarget, usage);
        if (correctionDrain.outcomeUnresolved) {
          throw new Error(
            "Correction terminal outcome is unresolved; stopping the owner workflow",
          );
        }
        if (blockedTurns.has(turnId)) {
          emitBlockedCompletion(turnId, usage);
          return;
        }
      }

      emitAgentMessage(turnId, phaseReports.join("\n\n"));
      emitTokenUsage(usage, turnId);
      emit({
        method: "turn/completed",
        params: { turn: { id: turnId }, usage },
      });
    } finally {
      client.close();
    }
  } catch (error) {
    if (!turnStarted)
      respond(turnStartResponseId, { turn: { id: fallbackTurnId } });
    throw error;
  } finally {
    closeCorrectionTarget(correctionTarget, "owner turn ended before correction execution");
    if (activeCorrectionTarget === correctionTarget) activeCorrectionTarget = null;
    await appServers.stop(ownedAppServer);
  }
}

async function submitWorkflowPhase(
  target,
  prompt,
  usage,
  submitTurn = submitAndWaitForTurn,
) {
  target.phaseActive = true;
  target.usage = usage;
  const localStop = new Promise((resolve) => { target.stopPhaseWait = resolve; });
  try {
    const terminal = await submitTurn(
      target.client, target.runtime, prompt, target.turnId, usage,
      { clientMessageId: `symphony-phase-${randomUUID()}`, localStop },
    );
    if (target.recoveryTakenOver) {
      throw new Error("Original phase outcome unresolved; explicit recovery is a separate instruction");
    }
    // Preserve the workflow's existing approval/input-required completion path.
    if (terminal.stopReason !== "requires_approval" && !blockedTurns.has(target.turnId)) {
      const error = correctionCompletionError(terminal);
      if (error) throw new Error(error);
    }
    return terminal;
  } catch (error) {
    closeCorrectionTarget(target, "owner turn ended before correction execution");
    // A separately authorized input must retain its own terminal waiter even
    // when the original phase times out or its local waiter is relinquished.
    if (target.drainPromise) await target.drainPromise;
    if (target.recoveryTakenOver) error.recoveryInstructionId = target.recoveryInstructionId;
    throw error;
  } finally {
    target.phaseActive = false;
    target.stopPhaseWait = null;
  }
}

function createCorrectionTarget(params, turnId, client, runtime) {
  const symphony = params.symphony || {};
  return {
    binding: {
      issueId: symphony.issueId,
      issueIdentifier: symphony.issueIdentifier,
      threadId,
      turnId,
      sessionId: `${threadId}-${turnId}`,
      workspacePath: symphony.workspacePath || params.cwd,
      workerPid: symphony.workerPid,
      workerHost: symphony.workerHost ?? null,
    },
    client,
    runtime,
    turnId,
    accepting: true,
    phaseActive: false,
    recoveryPending: false,
    validateAuthority: requestRecoveryAuthority,
    queue: [],
    emitStatus: emitCorrectionStatus,
    emitInputRequired,
  };
}

async function acceptCorrection(responseId, params) {
  const target = activeCorrectionTarget;
  const result = await acceptCorrectionForTarget(target, params);
  respond(responseId, { correction: result });
  if (result.status === "delivered" && params.recovery === true) {
    void drainCorrections(target, target.usage || {});
  }
}

async function acceptCorrectionForTarget(target, params, seen = acceptedCorrectionIds) {
  const fail = (error, status = "failed") => correctionStatus(params, status, { error });
  if (!target?.accepting) return fail("no active correction target");
  if (!correctionBindingMatches(params, target.binding)) {
    return fail("active correction target does not match");
  }
  if (typeof params.instructionId !== "string" || !params.instructionId.trim() ||
      typeof params.text !== "string" || !params.text.trim() ||
      (params.recovery !== undefined && typeof params.recovery !== "boolean")) {
    return fail("invalid correction payload");
  }
  if (seen.has(params.instructionId)) return fail("duplicate instruction id");
  // Reserve before any await: even failed recovery must use a NEW instruction ID.
  seen.add(params.instructionId);
  if (params.recovery === true) {
    if (!target.phaseActive || target.recoveryPending || target.drainPromise) {
      return fail("recovery requires one active phase with no correction drain", "blocked");
    }
    target.recoveryPending = true;
    try {
      await validateRecoveryAuthority(target, params, "acceptance");
      if (!target.phaseActive) throw new Error("owner phase is no longer active");
    } catch (error) {
      target.recoveryPending = false;
      return fail(formatError(error), "blocked");
    }
    // Older queued inputs are not revived by this authorization.
    for (const queued of target.queue.splice(0)) {
      target.emitStatus(queued, "failed", { error: "superseded by explicit recovery; not replayed" });
    }
  } else if (target.recoveryPending) {
    return fail("explicit recovery is already pending", "blocked");
  }
  target.queue.push({ ...params });
  return correctionStatus(params, "delivered");
}

async function requestRecoveryAuthority(target, correction, stage) {
  const id = `symphony-recovery-validation-${randomUUID()}`;
  const response = waitForSymphonyResponse(id, options.requestTimeoutMs);
  emit({ id, method: "symphony/correction/validate", params: {
    ...correction, runtime: target.runtime, stage,
  } });
  return (await response).result;
}

function strictRuntime(left, right) {
  return typeof left?.agent_id === "string" && left.agent_id.length > 0 &&
    typeof left.conversation_id === "string" && left.conversation_id.length > 0 &&
    left.agent_id === right?.agent_id && left.conversation_id === right?.conversation_id;
}

async function validateRecoveryAuthority(target, correction, stage) {
  if (!target.accepting || !correctionBindingMatches(correction, target.binding)) {
    throw new Error("recovery owner binding changed");
  }
  if (typeof correction.sourceRevision !== "string" || !correction.sourceRevision.trim() ||
      typeof correction.authorizationId !== "string" || !correction.authorizationId.trim() ||
      !Number.isSafeInteger(correction.cwdRevision) || correction.cwdRevision < 0 ||
      !strictRuntime(target.runtime, target.runtime)) {
    throw new Error("recovery requires source revision, authorization, cwd revision and exact runtime");
  }
  const runtime = { ...target.runtime };
  const authority = await target.validateAuthority(target, correction, stage);
  if (!target.accepting || !correctionBindingMatches(correction, target.binding) ||
      !strictRuntime(target.runtime, runtime) || authority?.current !== true ||
      !correctionBindingMatches(authority, target.binding) ||
      !strictRuntime(authority.runtime, runtime) ||
      authority.instructionId !== correction.instructionId || authority.text !== correction.text ||
      authority.sourceRevision !== correction.sourceRevision ||
      authority.authorizationId !== correction.authorizationId ||
      authority.cwdRevision !== correction.cwdRevision) {
    throw new Error("recovery owner/source revision/authorization is stale or superseded");
  }
}

async function inspectRecoveryIdle(target, correction, submit = () => {}) {
  const runtime = { ...target.runtime };
  let loop;
  let device;
  const detach = target.client.onMessage((message) => {
    if (!strictRuntime(message.runtime, runtime)) return;
    if (message.type === "update_loop_status") loop = message.loop_status;
    if (message.type === "update_device_status") device = message.device_status;
  });
  try {
    const requestId = `symphony-recovery-sync-${randomUUID()}`;
    const response = await target.client.request("sync", {
      runtime, request_id: requestId, recover_approvals: false, force_device_status: true,
    });
    const assertIdle = () => {
      if (response?.type !== "sync_response" || response.request_id !== requestId ||
        response.success !== true || !strictRuntime(response.runtime, runtime) ||
        !strictRuntime(target.runtime, runtime) ||
        loop?.status !== "WAITING_ON_INPUT" ||
        !Array.isArray(loop.executing_tool_call_ids) || loop.executing_tool_call_ids.length !== 0 ||
        !Array.isArray(loop.active_run_ids) || loop.active_run_ids.length !== 0 ||
        device?.current_working_directory !== correction.workspacePath ||
        device.cwd_revision !== correction.cwdRevision ||
        !Array.isArray(device.background_processes) || device.background_processes.length !== 0) {
        throw new Error("recovery deferred: fresh safe idle runtime/workspace evidence unavailable");
      }
    };
    assertIdle();
    return await submit(assertIdle);
  } finally {
    detach();
  }
}

function drainCorrections(target, usage, submitTurn = submitAndWaitForTurn) {
  if (target.drainPromise) return target.drainPromise;
  // Schedule after installing the lock, including when a test submitter resolves synchronously.
  target.drainPromise = Promise.resolve().then(() => drainCorrectionQueue(target, usage, submitTurn))
    .finally(() => { target.drainPromise = null; });
  return target.drainPromise;
}

async function drainCorrectionQueue(target, usage, submitTurn) {
  while (target.queue.length > 0) {
    const correction = target.queue.shift();
    let executionStarted = false;
    const markExecutionStarted = (runId) => {
      if (executionStarted) return;
      executionStarted = true;
      target.emitStatus(correction, "execution_started", { runId });
    };

    let submissionAttempted = false;
    try {
      const submit = () => {
        submissionAttempted = true;
        return submitTurn(
          target.client,
          target.runtime,
          correction.text,
          target.turnId,
          usage,
          {
            clientMessageId: `symphony-correction-${correction.instructionId}`,
            onAccepted: (acceptance) => {
              if (!acceptance.accepted) {
                throw new Error(acceptance.error || "correction input was rejected");
              }
            },
            onExecutionStarted: (runId) => {
              markExecutionStarted(runId);
            },
          },
        );
      };
      const terminal = correction.recovery === true
        ? await inspectRecoveryIdle(target, correction, async (assertIdle) => {
          await validateRecoveryAuthority(target, correction, "submission");
          assertIdle();
          if (!target.phaseActive) throw new Error("owner phase is no longer active");
          target.recoveryTakenOver = true;
          target.recoveryInstructionId = correction.instructionId;
          // Relinquish only the local waiter; never abort a native run or Bash.
          target.stopPhaseWait?.({ stopReason: "recovery_handoff", text: "" });
          return submit();
        })
        : await submit();

      if (
        terminal.stopReason === "input_required" ||
        terminal.stopReason === "requires_approval"
      ) {
        target.emitStatus(correction, "blocked", {
          runId: terminal.runId,
          error:
            terminal.stopReason === "requires_approval"
              ? "correction turn requires operator approval"
              : "correction turn requires operator input",
        });
        closeCorrectionTarget(target, "owner turn blocked before correction execution");
        (target.emitInputRequired || emitInputRequired)(
          target.turnId,
          terminal.blocker ||
            (terminal.stopReason === "requires_approval"
              ? "Correction turn requires operator approval."
              : "Correction turn requires operator input."),
        );
        break;
      }

      const completionError = correctionCompletionError(terminal);
      if (completionError) throw new Error(completionError);

      target.emitStatus(correction, "completed", {
        runId: terminal.runId,
        result: terminal.text || "Completed.",
      });
    } catch (error) {
      target.emitStatus(correction, correction.recovery === true && !submissionAttempted ? "blocked" : "failed", {
        error: formatError(error),
      });
      if (error?.correctionOutcomeUnresolved) {
        closeCorrectionTarget(
          target,
          "earlier accepted correction has no observed terminal outcome",
        );
        return { outcomeUnresolved: true };
      }
    } finally {
      if (correction.recovery === true) target.recoveryPending = false;
    }
  }

  return { outcomeUnresolved: false };
}

function closeCorrectionTarget(target, error) {
  if (!target) return;
  target.accepting = false;
  for (const correction of target.queue.splice(0)) {
    target.emitStatus(correction, "failed", { error });
  }
}

function correctionBindingMatches(params, binding) {
  return (
    params.issueId === binding.issueId &&
    params.issueIdentifier === binding.issueIdentifier &&
    params.threadId === binding.threadId &&
    params.expectedTurnId === binding.turnId &&
    params.sessionId === binding.sessionId &&
    params.workspacePath === binding.workspacePath &&
    params.workerPid === binding.workerPid &&
    (params.workerHost ?? null) === binding.workerHost
  );
}

function correctionStatus(correction, status, extra = {}) {
  return {
    instructionId: correction.instructionId,
    issueId: correction.issueId,
    issueIdentifier: correction.issueIdentifier,
    threadId: correction.threadId,
    expectedTurnId: correction.expectedTurnId,
    sessionId: correction.sessionId,
    workspacePath: correction.workspacePath,
    workerPid: correction.workerPid,
    workerHost: correction.workerHost ?? null,
    status,
    ...extra,
  };
}

function correctionCompletionError(terminal) {
  if (!terminal || typeof terminal !== "object") {
    return "correction turn returned no terminal evidence";
  }
  if (terminal.stopReason === "end_turn" || terminal.stopReason === "tool_rule") {
    return null;
  }
  return (
    terminal.error ||
    `correction turn ended with stop reason ${terminal.stopReason || "unknown"}`
  );
}

function emitCorrectionStatus(correction, status, extra = {}) {
  emit({
    method: "symphony/correction/status",
    params: correctionStatus(correction, status, extra),
  });
}

async function startRuntime(client, cwd) {
  const agentId =
    options.agentId ||
    (options.agentName
      ? await resolveAgentNameViaCli(options.agentName, cwd)
      : undefined);
  const response = await client.runtimeStart(
    {
      agent_id: agentId,
      create_conversation: { title: "Symphony Letta worker" },
      cwd,
      ...(options.permissionMode ? { mode: options.permissionMode } : {}),
      skill_sources: options.skillSources,
      client_info: {
        name: "codex-bridge",
        title: "Letta Codex App Server Bridge",
        version: "0.2.0",
      },
      ...(dynamicTools.length > 0
        ? {
            external_tools: [
              {
                scope_id: "symphony-dynamic-tools",
                tools: normalizeExternalTools(dynamicTools),
              },
            ],
          }
        : {}),
      wait_for_replay: false,
    },
    { timeoutMs: options.requestTimeoutMs },
  );

  if (!response.success || !response.runtime) {
    throw new Error(
      `runtime_start failed: ${response.error || JSON.stringify(response)}`,
    );
  }

  return {
    runtime: response.runtime,
    conversation: response.conversation,
    agent: response.agent,
  };
}

function conversationIdFromRuntime(runtimeContext) {
  return (
    runtimeContext?.conversation?.id ||
    runtimeContext?.runtime?.conversation_id ||
    null
  );
}

async function handleExternalToolCall(client, message, turnId) {
  if (message.type !== "external_tool_call_request") return;

  if (isInputRequiredTool(message.tool_name)) {
    client.send({
      type: "external_tool_call_response",
      request_id: message.request_id,
      error: "operator input required",
    });
    return;
  }

  const requestId = `symphony-tool-${randomUUID()}`;
  emitProgress(
    turnId,
    summarizeExternalToolCall(message.tool_name, message.input),
  );
  emit({
    id: requestId,
    method: "item/tool/call",
    params: {
      tool: message.tool_name,
      name: message.tool_name,
      arguments: message.input || {},
    },
  });

  try {
    const response = await waitForSymphonyResponse(
      requestId,
      options.requestTimeoutMs,
    );
    client.send({
      type: "external_tool_call_response",
      request_id: message.request_id,
      result: externalToolResult(response.result),
    });
    emitProgress(
      turnId,
      summarizeExternalToolResult(message.tool_name, response.result),
    );
  } catch (error) {
    emitAgentMessage(
      turnId,
      `External tool failed: ${message.tool_name}: ${formatError(error)}`,
    );
    client.send({
      type: "external_tool_call_response",
      request_id: message.request_id,
      error: formatError(error),
    });
  }
}

function waitForSymphonyResponse(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingSymphonyResponses.delete(id);
      reject(
        new Error(`Timed out waiting for Symphony dynamic tool response ${id}`),
      );
    }, timeoutMs);

    pendingSymphonyResponses.set(id, {
      resolve: (message) => {
        clearTimeout(timeout);
        resolve(message);
      },
    });
  });
}

function normalizeExternalTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label || tool.name,
    description: tool.description || "Symphony dynamic tool",
    parameters: tool.parameters ||
      tool.inputSchema || { type: "object", additionalProperties: true },
  }));
}

function externalToolResult(result) {
  const success = result?.success !== false;
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? null) }],
    ...(success ? {} : { is_error: true }),
  };
}

class AppServerBridgeClient {
  constructor(socket, requestTimeoutMs) {
    this.socket = socket;
    this.requestTimeoutMs = requestTimeoutMs;
    this.requestCounter = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = new Promise((resolve) => {
      socket.addEventListener(
        "close",
        () => {
          const error = new Error("Letta App Server WebSocket closed");
          this.rejectAll(error);
          resolve(error);
        },
        { once: true },
      );
    });

    socket.addEventListener("message", (event) => this.handleMessage(event));
  }

  static async connect(url, { requestTimeoutMs }) {
    if (typeof WebSocket !== "function") {
      throw new Error(
        "Global WebSocket is unavailable; use Node.js 22.19 or newer",
      );
    }

    const socket = new WebSocket(normalizeWebSocketUrl(url));
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Failed to open Letta App Server WebSocket")),
        { once: true },
      );
    });
    return new AppServerBridgeClient(socket, requestTimeoutMs);
  }

  onMessage(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close() {
    this.socket.close();
  }

  waitForClose() {
    return this.closed.then((error) => Promise.reject(error));
  }

  runtimeStart(command, options = {}) {
    return this.request("runtime_start", command, options);
  }

  submitInput(command, options = {}) {
    return this.request("input", command, options);
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  request(type, body, options = {}) {
    const requestId = body.request_id || `${type}-${++this.requestCounter}`;
    const message = { type, request_id: requestId, ...body };
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for ${requestId}`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timeout });
      this.socket.send(JSON.stringify(message));
    });
  }

  handleMessage(event) {
    const message = JSON.parse(
      typeof event.data === "string" ? event.data : String(event.data),
    );

    for (const handler of this.handlers) handler(message);

    const requestId = message.request_id;
    if (typeof requestId !== "string") return;

    const pending = this.pending.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve(message);
  }

  rejectAll(error) {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }
}

function createAppServerBridgeClientForTest(socket, requestTimeoutMs) {
  return new AppServerBridgeClient(socket, requestTimeoutMs);
}

function normalizeWebSocketUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/ws";
  return parsed.toString();
}

async function submitAndWaitForTurn(client, runtime, prompt, turnId, usage, hooks = {}) {
  const runEvents = [];
  const runIdsByToolCallId = new Map();
  const pendingCorrelationMessages = [];
  const pendingToolCorrelationMessages = [];
  let replayingToolCorrelationMessages = false;
  let executionObserved = false;
  let executionReported = false;
  let correctionRunId = null;
  let inputAccepted = false;
  let inputRejected = false;
  let inputSubmissionAttempted = false;
  let terminalOutcomeObserved = false;
  let observedTerminal = null;
  addTokenUsage(usage, { input: estimateTokens(prompt) });
  emitTokenUsage(usage, turnId);

  let detach = () => {};
  const terminal = new Promise((resolve) => {
    const resolveTerminal = (result) => {
      if (observedTerminal) return;
      observedTerminal = result;
      resolve(result);
    };
    const replayToolCorrelationMessages = () => {
      if (
        !correctionRunId ||
        replayingToolCorrelationMessages ||
        pendingToolCorrelationMessages.length === 0
      ) {
        return;
      }
      replayingToolCorrelationMessages = true;
      const pending = pendingToolCorrelationMessages.splice(0);
      for (const pendingMessage of pending) processMessage(pendingMessage);
      replayingToolCorrelationMessages = false;
    };
    const processMessage = (message) => {
      if (!sameRuntime(message.runtime, runtime)) return;

      if (recordToolRunCorrelations(message, runIdsByToolCallId)) {
        replayToolCorrelationMessages();
      }

      const queueDisposition = queueDispositionForMessage(
        message,
        hooks.clientMessageId,
      );

      if (queueDisposition === "dequeued") {
        executionObserved = true;
      } else if (queueDisposition === "cancelled") {
        resolveTerminal({ cancelled: true, text: collapseText(runEvents) });
        return;
      }

      const correlatedRunId = correctionRunIdForMessage(
        message,
        hooks.clientMessageId,
        correctionRunId,
        pendingCorrelationMessages.map(runIdForMessage).filter(Boolean),
      );
      if (correlatedRunId) {
        correctionRunId = correlatedRunId;
        executionObserved = true;
        const pending = pendingCorrelationMessages.splice(0);
        for (const pendingMessage of pending) {
          recordToolRunCorrelations(pendingMessage, runIdsByToolCallId);
        }
        for (const pendingMessage of pending) processMessage(pendingMessage);
      }

      if (
        hooks.clientMessageId &&
        executionObserved &&
        correctionRunId &&
        !executionReported
      ) {
        executionReported = true;
        if (hooks.onExecutionStarted) hooks.onExecutionStarted(correctionRunId);
      }

      if (
        hooks.clientMessageId &&
        !correctionRunId &&
        (message.type === "external_tool_call_request" ||
          message.type === "control_request" ||
          message.type === "stream_delta" ||
          message.type === "turn_finished")
      ) {
        pendingCorrelationMessages.push(message);
        return;
      }

      const eventRunId = runIdForMessage(message);
      if (
        hooks.clientMessageId &&
        eventRunId &&
        eventRunId !== correctionRunId
      ) {
        pendingCorrelationMessages.push(message);
        return;
      }

      if (
        message.type === "external_tool_call_request" &&
        isInputRequiredTool(message.tool_name)
      ) {
        const toolRunId = runIdsByToolCallId.get(message.tool_call_id);
        if (hooks.clientMessageId && !toolRunId) {
          pendingToolCorrelationMessages.push(message);
          return;
        }
        if (
          hooks.clientMessageId &&
          toolRunId !== correctionRunId
        ) {
          pendingToolCorrelationMessages.push(message);
          return;
        }
        const blocker = inputRequiredBlockerForTool(
          message.tool_name,
          message.input,
        );
        if (!hooks.clientMessageId) emitInputRequired(turnId, blocker);
        resolveTerminal({
          stopReason: "input_required",
          runId: correctionRunId,
          blocker,
          text: collapseText(runEvents),
        });
        return;
      }

      if (
        message.type === "control_request" &&
        message.request?.subtype === "can_use_tool"
      ) {
        const toolRunId = runIdsByToolCallId.get(message.request.tool_call_id);
        if (hooks.clientMessageId && !toolRunId) {
          pendingToolCorrelationMessages.push(message);
          return;
        }
        if (
          hooks.clientMessageId &&
          toolRunId !== correctionRunId
        ) {
          pendingToolCorrelationMessages.push(message);
          return;
        }
        const inputRequired = isInputRequiredTool(message.request.tool_name);
        const blocker = inputRequired
          ? inputRequiredBlockerForTool(
              message.request.tool_name,
              message.request.input,
            )
          : {
              reason: `${message.request.tool_name || "Tool"} requires operator approval`,
              missing: [],
              remainingScope: "operator approval",
            };
        if (!hooks.clientMessageId) emitInputRequired(turnId, blocker);
        resolveTerminal({
          stopReason: inputRequired ? "input_required" : "requires_approval",
          runId: correctionRunId,
          blocker,
          text: collapseText(runEvents),
        });
        return;
      }

      if (message.type === "stream_delta") {
        if (
          hooks.clientMessageId &&
          message.delta?.run_id !== correctionRunId
        ) {
          return;
        }
        const text = textFromStreamDelta(message.delta);
        if (text) {
          runEvents.push(text);
          addTokenUsage(usage, { output: estimateTokens(text) });
          emitTokenUsage(usage, turnId);
        }
        const streamBlocker = forwardStreamDelta(
          turnId,
          message.delta,
          usage,
          hooks.clientMessageId !== undefined,
        );
        if (streamBlocker && !hooks.clientMessageId) {
          resolveTerminal({
            stopReason: "input_required",
            runId: correctionRunId,
            blocker: streamBlocker,
            text: collapseText(runEvents),
          });
          return;
        }
        if (blockedTurns.has(turnId)) {
          resolveTerminal({
            stopReason: "input_required",
            runId: correctionRunId,
            text: collapseText(runEvents),
          });
        }
      }

      if (message.type === "turn_finished") {
        if (
          hooks.clientMessageId &&
          pendingToolCorrelationMessages.some((pendingMessage) => {
            const toolCallId = toolCallIdForControlMessage(pendingMessage);
            const toolRunId = runIdsByToolCallId.get(toolCallId);
            return !toolRunId || toolRunId === correctionRunId;
          })
        ) {
          pendingToolCorrelationMessages.push(message);
          return;
        }
        if (
          hooks.clientMessageId &&
          (!correctionRunId || message.run_id !== correctionRunId)
        ) {
          return;
        }
        resolveTerminal({
          stopReason: message.stop_reason,
          runId: message.run_id,
          turnId: message.turn_id,
          error: message.error,
          text: collapseText(runEvents),
        });
      }
    };

    detach = client.onMessage(processMessage);
  });

  try {
    inputSubmissionAttempted = true;
    let acceptance;
    try {
      acceptance = await client.submitInput(
        {
          runtime,
          payload: {
            kind: "create_message",
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
                client_message_id: hooks.clientMessageId || `symphony-${randomUUID()}`,
              },
            ],
            ...(dynamicTools.length > 0
              ? { external_tool_scope_ids: ["symphony-dynamic-tools"] }
              : {}),
          },
        },
        { timeoutMs: options.requestTimeoutMs },
      );
    } catch (error) {
      if (hooks.clientMessageId && observedTerminal) {
        terminalOutcomeObserved = true;
        if (observedTerminal.cancelled) {
          throw new Error("correction input was cancelled before execution");
        }
        return observedTerminal;
      }
      throw error;
    }

    inputAccepted = acceptance.accepted === true;
    inputRejected = !inputAccepted;
    if (hooks.onAccepted) hooks.onAccepted(acceptance);
    if (acceptance.accepted && acceptance.disposition === "started") {
      executionObserved = true;
      if (correctionRunId && !executionReported) {
        executionReported = true;
        if (hooks.onExecutionStarted) hooks.onExecutionStarted(correctionRunId);
      }
    }

    const result = await withTimeout(
      Promise.race([terminal, client.waitForClose(), ...(hooks.localStop ? [hooks.localStop] : [])]),
      options.turnTimeoutMs,
      "Timed out waiting for Letta turn_finished",
    );
    terminalOutcomeObserved = true;

    if (result.cancelled) throw new Error("correction input was cancelled before execution");
    if (hooks.clientMessageId && !executionObserved) {
      throw new Error("correction execution could not be correlated to its queued input");
    }

    return result;
  } catch (error) {
    if (
      hooks.clientMessageId &&
      inputSubmissionAttempted &&
      !inputRejected &&
      !terminalOutcomeObserved &&
      !error?.correctionOutcomeUnresolved
    ) {
      const acceptance = inputAccepted ? "was accepted" : "may have been accepted";
      const unresolved = new Error(
        `Correction input ${acceptance} but its terminal outcome is unresolved: ${formatError(error)}`,
        { cause: error },
      );
      unresolved.correctionOutcomeUnresolved = true;
      throw unresolved;
    }
    throw error;
  } finally {
    detach();
  }
}

function recordToolRunCorrelations(message, runIdsByToolCallId) {
  if (message?.type !== "stream_delta") return false;

  const delta = message.delta;
  if (typeof delta?.run_id !== "string") return false;

  let toolCallIds = [];
  if (
    delta.message_type === "client_tool_start" &&
    typeof delta.tool_call_id === "string"
  ) {
    toolCallIds = [delta.tool_call_id];
  } else if (delta.message_type === "approval_request_message") {
    const toolCalls =
      Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
      ? delta.tool_calls
      : delta.tool_call
        ? [delta.tool_call]
        : [];
    toolCallIds = toolCalls
      .map((toolCall) => toolCall?.tool_call_id)
      .filter((toolCallId) => typeof toolCallId === "string");
  }

  for (const toolCallId of toolCallIds) {
    runIdsByToolCallId.set(toolCallId, delta.run_id);
  }
  return toolCallIds.length > 0;
}

function runIdForMessage(message) {
  if (message?.type === "stream_delta" && typeof message.delta?.run_id === "string") {
    return message.delta.run_id;
  }
  if (message?.type === "turn_finished" && typeof message.run_id === "string") {
    return message.run_id;
  }
  return null;
}

function toolCallIdForControlMessage(message) {
  if (message?.type === "external_tool_call_request") {
    return message.tool_call_id;
  }
  if (message?.type === "control_request") {
    return message.request?.tool_call_id;
  }
  return null;
}

function queueDispositionForMessage(message, clientMessageId) {
  if (
    message?.type !== "update_queue" ||
    typeof clientMessageId !== "string" ||
    !Array.isArray(message.removed)
  ) {
    return null;
  }

  const transition = message.removed.find(
    (item) => item?.client_message_id === clientMessageId,
  );
  return transition?.disposition || null;
}

function correctionRunIdForMessage(
  message,
  clientMessageId,
  currentRunId = null,
  observedRunIds = [],
) {
  if (
    message?.type !== "update_loop_status" ||
    typeof clientMessageId !== "string" ||
    !message.loop_status?.client_message_ids_by_run_id
  ) {
    return null;
  }

  const matches = Object.entries(
    message.loop_status.client_message_ids_by_run_id,
  )
    .filter(
      ([, clientMessageIds]) =>
        Array.isArray(clientMessageIds) &&
        clientMessageIds.includes(clientMessageId),
    )
    .map(([runId]) => runId);

  const activeRunIds = Array.isArray(message.loop_status.active_run_ids)
    ? message.loop_status.active_run_ids
    : [];
  const activeMatches = matches.filter((runId) => activeRunIds.includes(runId));

  if (activeMatches.length === 1) return activeMatches[0];
  if (activeMatches.length > 1) return null;
  const observedMatches = [
    ...new Set(
      observedRunIds.filter(
        (runId) => runId !== currentRunId && matches.includes(runId),
      ),
    ),
  ];
  if (observedMatches.length === 1) return observedMatches[0];
  if (observedMatches.length > 1) return null;
  if (currentRunId && matches.includes(currentRunId)) return currentRunId;
  return matches.length === 1 ? matches[0] : null;
}

function buildWorkflowPhases(prompt) {
  if (options.workflow === "single") return [{ name: "execute", prompt }];

  return [
    {
      name: "plan",
      prompt: `${prompt}\n\nYou are in the planning phase. Restate the task, identify constraints, and produce a concise implementation and verification plan. Do not edit files in this phase.`,
    },
    {
      name: "execute",
      prompt: `${prompt}\n\nYou are in the execution phase. Implement the plan, run relevant verification, and report the exact changes and commands. Do not mark the work complete unless verification has evidence.`,
    },
    {
      name: "review",
      prompt: `${prompt}\n\nYou are in the review phase. Review the resulting diff and verification evidence. List Critical, Important, and Minor findings with file references. If you find issues, fix Critical and Important issues, rerun targeted verification, and report the outcome.`,
    },
  ];
}

function buildPrompt(params) {
  const inputText = Array.isArray(params.input)
    ? params.input
        .filter((item) => item?.type === "text")
        .map((item) => item.text || "")
        .join("\n\n")
    : "";

  const title = params.title ? `Title: ${params.title}\n\n` : "";
  return `${title}${inputText}`.trim();
}

async function resolveAppServer({
  appServerUrl = options.appServerUrl,
  manager = appServers,
  lettaBin = options.lettaBin,
  backend = options.backend,
  listenUrl = options.listenUrl,
  startTimeoutMs = options.serverStartTimeoutMs,
} = {}) {
  if (appServerUrl) return { url: appServerUrl, child: null };
  return manager.start({ lettaBin, backend, listenUrl, startTimeoutMs });
}

function waitForListeningUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Listening on (ws:\/\/[^\s]+)/);
      if (match) {
        settle(resolve, match[1]);
        child.stdout.resume();
        child.stderr.resume();
      }
    };
    const onError = (error) => settle(reject, error);
    const onExit = (status) =>
      settle(
        reject,
        new Error(
          `letta server exited before listening with status ${status}. Output:\n${output}`,
        ),
      );
    const timer = setTimeout(
      () =>
        settle(
          reject,
          new Error(
            `Timed out waiting for letta server to listen. Output:\n${output}`,
          ),
        ),
      timeoutMs,
    );

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function resolveAgentNameViaCli(agentName, cwd) {
  const result = await runCommand(
    options.lettaBin,
    ["agents", "list", "--name", agentName, "--backend", options.backend],
    cwd,
  );
  const parsed = JSON.parse(result.stdout);
  const matches = parsed.items || [];

  if (matches.length === 0)
    throw new Error(
      `No Letta agent found with name ${JSON.stringify(agentName)}`,
    );
  if (matches.length > 1)
    throw new Error(
      `Multiple Letta agents found with name ${JSON.stringify(agentName)}; use --agent <id>`,
    );
  return matches[0].id;
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.AGENT_ID;
    delete env.CONVERSATION_ID;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolve({ stdout, stderr, status });
      else
        reject(new Error(`${command} exited with status ${status}\n${stderr}`));
    });
  });
}

function forwardStreamDelta(turnId, delta, usage, deferInputRequired = false) {
  const messageType = delta?.message_type;

  if (delta?.type === "message") {
    const text = extractText(delta);
    if (meaningfulStreamingText(text))
      emitProgress(turnId, summarizeAgentText(text));
  }

  if (messageType === "command_start") {
    emit({
      method: "item/started",
      params: {
        turnId,
        item: {
          id: delta.command_id,
          type: "commandExecution",
          status: "running",
        },
        command: previewText(delta.input || ""),
      },
    });
    emitProgress(turnId, summarizeCommandStart(delta.input));
  }

  if (messageType === "command_end") {
    const output = previewText(delta.output || "");
    emit({
      method: "item/commandExecution/outputDelta",
      params: { turnId, outputDelta: output },
    });
    emit({
      method: "item/completed",
      params: {
        turnId,
        item: {
          id: delta.command_id,
          type: "commandExecution",
          status: delta.success ? "completed" : "failed",
        },
        command: previewText(delta.input || ""),
      },
    });
    emitProgress(turnId, summarizeCommandEnd(delta));
  }

  if (messageType === "client_tool_start") {
    if (delta.tool_call_id && delta.tool_name)
      toolNamesById.set(delta.tool_call_id, delta.tool_name);
    if (isInputRequiredTool(delta.tool_name)) {
      const blocker = {
        reason: `${delta.tool_name} requested operator input`,
        missing: [],
        remainingScope: "operator input",
      };
      if (deferInputRequired) return blocker;
      emitInputRequired(turnId, blocker);
      return null;
    }
    emitProgress(turnId, summarizeClientToolStart(delta.tool_name));
  }

  if (messageType === "client_tool_end") {
    const toolName =
      toolNamesById.get(delta.tool_call_id) || delta.tool_name || "tool";
    if (delta.tool_call_id) toolNamesById.delete(delta.tool_call_id);
    emitProgress(turnId, summarizeClientToolEnd(toolName, delta.status));
  }

  if (messageType === "status")
    emitProgress(turnId, summarizeStatusMessage(delta.message));
  if (messageType === "retry")
    emitProgress(
      turnId,
      progress("일시 실패 복구", `재시도 대기: ${previewText(delta.message)}`),
    );
  if (messageType === "loop_error")
    emitProgress(
      turnId,
      progress(
        "agent loop 장애 확인",
        `오류 확인: ${previewText(delta.message)}`,
      ),
    );

  const reported = extractUsage(delta);
  if (reported) {
    usage.input_tokens = Math.max(
      usage.input_tokens,
      reported.input_tokens || 0,
    );
    usage.output_tokens = Math.max(
      usage.output_tokens,
      reported.output_tokens || 0,
    );
    usage.total_tokens = Math.max(
      usage.total_tokens,
      reported.total_tokens || usage.input_tokens + usage.output_tokens,
    );
    emitTokenUsage(usage, turnId);
  }

  return null;
}

function textFromStreamDelta(delta) {
  if (!delta || typeof delta !== "object") return "";
  if (delta.message_type === "status" || delta.message_type === "loop_error")
    return delta.message || "";
  if (delta.message_type === "command_end") return delta.output || "";
  if (delta.type === "message") return extractText(delta);
  return "";
}

function summarizeCommandStart(input) {
  const command = previewText(input || "");
  if (!command) return progress("현재 작업 진행", "명령 실행");
  if (command.includes("gh pr checks"))
    return progress("PR 병합 차단 여부 확인", "GitHub PR checks 조회");
  if (command.includes("gh pr view"))
    return progress("PR 상태 판단", "GitHub PR 메타데이터 조회");
  if (command.includes("gh run view"))
    return progress("CI 실패 원인 분석", "GitHub Actions 로그 확인");
  if (command.includes("git rebase"))
    return progress("브랜치 최신화", "base branch 위로 rebase");
  if (command.includes("git push"))
    return progress("원격 PR 갱신", "branch push");
  if (command.includes("uv sync"))
    return progress("검증 환경 구성", "Python dependencies 설치");
  if (command.includes("pytest"))
    return progress("기능 회귀 검증", "pytest 실행");
  if (command.includes("prek") || command.includes("pre-commit"))
    return progress("코드 품질 검증", "prek/pre-commit 실행");
  return progress("현재 작업 진행", `명령 실행: ${command}`);
}

function summarizeCommandEnd(delta) {
  const input = previewText(delta.input || "");
  const output = String(delta.output || "");
  const semantic = semanticStatusFromText(output);
  if (semantic) return semantic;
  if (delta.success)
    return progress("절차 완료", `명령 성공: ${input || "command"}`);
  return progress("문제 원인 확인 필요", `명령 실패: ${input || "command"}`);
}

function summarizeStatusMessage(message) {
  const text = previewText(message || "");
  if (/^tool (success|started):\s*\w+/i.test(text)) return "";
  if (/^tool (success|started): exec_command\b/i.test(text)) return "";
  if (
    /^tool (success|started): (read|grep|glob|edit|apply_patch)\b/i.test(text)
  )
    return "";
  return semanticStatusFromText(message) || progress("현재 작업 진행", text);
}

function summarizeClientToolStart(toolName) {
  const tool = String(toolName || "tool");
  if (tool === "exec_command")
    return progress("작업 증거 수집 또는 변경 적용", "workspace 명령 실행");
  if (tool === "github_api")
    return progress("PR/이슈 맥락 확인", "GitHub API 호출");
  if (tool === "apply_patch" || tool === "edit")
    return progress("수정안 적용", "파일 편집");
  if (tool === "read" || tool === "grep" || tool === "glob")
    return progress("구현 맥락 파악", "파일/텍스트 조회");
  return progress("현재 작업 진행", `tool 실행: ${tool}`);
}

function summarizeClientToolEnd(toolName, status) {
  const tool = String(toolName || "tool");
  if (tool === "exec_command" && status === "success") return "";
  if (tool === "github_api" && status === "success")
    return progress("다음 조치 결정", "GitHub 응답 해석");
  if (["read", "grep", "glob"].includes(tool) && status === "success")
    return progress("구현 방향 결정", "읽은 맥락 정리");
  if (["apply_patch", "edit"].includes(tool) && status === "success")
    return progress("수정 검증 준비", "파일 편집 완료");
  return progress("tool 결과 확인", `${tool} ${status}`);
}

function summarizeExternalToolCall(toolName, input) {
  const tool = String(toolName || "tool");
  const text = JSON.stringify(input || {});
  if (tool === "github_api" && /pull|pr|check|review|run/i.test(text))
    return progress("PR 진행 상태 판단", "GitHub PR/check/review 조회");
  if (tool === "github_api")
    return progress("이슈 요구사항 파악", "GitHub issue 조회");
  return progress("외부 tracker 맥락 확인", `${tool} 호출`);
}

function summarizeExternalToolResult(toolName, result) {
  const tool = String(toolName || "tool");
  const text =
    typeof result === "string" ? result : JSON.stringify(result || {});
  return (
    semanticStatusFromText(text) ||
    (tool === "github_api"
      ? progress("다음 조치 결정", "GitHub 응답 해석")
      : progress("외부 tracker 확인 완료", `${tool} 응답 해석`))
  );
}

function summarizeAgentText(text) {
  const value = previewText(text);
  const semantic = semanticStatusFromText(value);
  if (semantic) return semantic;
  return progress("agent 판단 공유", value);
}

function semanticStatusFromText(text) {
  const value = String(text || "");
  if (!value.trim()) return "";

  if (value.includes("No space left on device")) {
    return progress(
      "CI 디스크 부족 해결",
      "GitHub runner dependency build 실패 확인",
    );
  }
  if (
    value.includes("Repository not found") &&
    value.includes("nautilus_trader")
  ) {
    return progress(
      "private dependency 인증 문제 해결",
      "nautilus_trader repository 접근 실패 확인",
    );
  }
  if (
    value.includes("Invalid username or token") &&
    value.includes("nautilus_trader")
  ) {
    return progress(
      "private dependency token 문제 해결",
      "nautilus_trader 인증 실패 확인",
    );
  }
  if (
    value.includes("unresolved-import") ||
    value.includes("Cannot resolve imported module")
  ) {
    return progress(
      "check 환경 의존성 문제 해결",
      "unresolved import 실패 확인",
    );
  }
  if (
    /\b(status|conclusion)[:=]\s*(IN_PROGRESS|pending)\b/i.test(value) ||
    /\bpending\b/i.test(value)
  ) {
    return progress("최신 검증 결과 대기", "GitHub checks 진행 상태 확인");
  }
  if (/\b(conclusion|status)[:=]\s*(FAILURE|failed|fail)\b/i.test(value)) {
    return progress("CI 실패 원인 분석", "실패한 GitHub checks 식별");
  }
  if (/\b(conclusion|status)[:=]\s*(SUCCESS|passed|pass)\b/i.test(value)) {
    return progress("검증 통과 확인", "GitHub checks 성공 확인");
  }

  return "";
}

function progress(meaning, procedure) {
  return `${previewText(meaning)}: ${previewText(procedure)}`;
}

function extractText(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content))
    return value.content.map(extractText).filter(Boolean).join("\n");
  if (typeof value.message === "string") return value.message;
  if (value.delta) return extractText(value.delta);
  return "";
}

function collapseText(events) {
  return events.join("").trim().slice(-options.maxReportChars);
}

function emitProgress(turnId, text) {
  if (!text) return;
  const progress = previewText(text);
  if (!progress) return;
  lastProgressByTurn.set(turnId, progress);
  emit({
    method: "codex/event/exec_command_begin",
    params: { turnId, msg: { command: progress } },
  });
}

function emitInputRequired(turnId, blocker) {
  if (blockedTurns.has(turnId)) return;
  blockedTurns.add(turnId);
  const reason = previewText(blocker.reason || "operator input required");
  lastProgressByTurn.set(turnId, progress("operator input 필요", reason));
  emit({
    method: "turn/input_required",
    params: {
      turnId,
      input_required: true,
      reason,
      missing: blocker.missing,
      remaining_scope: blocker.remainingScope,
    },
  });
}

function emitBlockedCompletion(turnId, usage) {
  emit({
    method: "turn/completed",
    params: {
      turn: { id: turnId },
      outcome: "input_required",
      completion: { outcome: "input_required" },
      usage,
    },
  });
}

function inputRequiredBlockerForTool(toolName, input) {
  return {
    reason: inputRequiredReason(toolName, input),
    missing: [],
    remainingScope: "operator input",
  };
}

function inputRequiredReason(toolName, input) {
  if (typeof input?.question === "string" && input.question.trim())
    return input.question.trim();
  const questions = Array.isArray(input?.questions)
    ? input.questions
        .map((question) => question?.question)
        .filter((question) => typeof question === "string" && question.trim())
    : [];
  if (questions.length > 0) return questions.join(" ");
  return `${toolName || "tool"} requested operator input`;
}

function isInputRequiredTool(toolName) {
  const normalized = String(toolName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return (
    normalized === "askuserquestion" ||
    normalized.endsWith("_askuserquestion") ||
    normalized === "ask_user_question" ||
    normalized.endsWith("_ask_user_question") ||
    normalized === "request_user_input" ||
    normalized.endsWith("_request_user_input") ||
    normalized === "user_input" ||
    normalized.endsWith("_user_input")
  );
}

function emitTokenUsage(usage, turnId = null) {
  emit({
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { total: { ...usage } } },
  });
  if (turnId && blockedTurns.has(turnId)) return;
  if (turnId && lastProgressByTurn.has(turnId)) {
    emit({
      method: "codex/event/exec_command_begin",
      params: { turnId, msg: { command: lastProgressByTurn.get(turnId) } },
    });
  }
}

function addTokenUsage(usage, { input = 0, output = 0 }) {
  usage.input_tokens += input;
  usage.output_tokens += output;
  usage.total_tokens = usage.input_tokens + usage.output_tokens;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function extractUsage(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [
    value.total_token_usage,
    value.token_usage,
    value.usage,
    value.info?.total_token_usage,
    value.payload?.info?.total_token_usage,
    value.payload?.usage,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const input = integerFrom(
      candidate.input_tokens ?? candidate.prompt_tokens,
    );
    const output = integerFrom(
      candidate.output_tokens ?? candidate.completion_tokens,
    );
    const total = integerFrom(candidate.total_tokens);
    if (input !== null || output !== null || total !== null) {
      return {
        input_tokens: input ?? 0,
        output_tokens: output ?? 0,
        total_tokens: total ?? (input ?? 0) + (output ?? 0),
      };
    }
  }
  return null;
}

function integerFrom(value) {
  return Number.isInteger(value) ? value : null;
}

function previewText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function meaningfulStreamingText(text) {
  const preview = previewText(text);
  if (!preview) return false;
  if (/^tool (success|started|failed):\s*\w+/i.test(preview)) return false;
  if (preview.length < 12 && /^[\p{P}\p{S}\s\w]*$/u.test(preview)) return false;
  return true;
}

function shutdownBridge(exitCode) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    let finalExitCode = exitCode;
    try {
      await appServers.stopAll();
    } catch (error) {
      process.stderr.write(
        `Failed to stop Letta App Servers cleanly: ${formatError(error)}\n`,
      );
      finalExitCode = finalExitCode || 1;
    }
    process.exit(finalExitCode);
  })();
  return shutdownPromise;
}

function sameRuntime(left, right) {
  if (!left || !right) return true;
  return (
    (!right.agent_id || left.agent_id === right.agent_id) &&
    (!right.conversation_id || left.conversation_id === right.conversation_id)
  );
}

function emitAgentMessage(turnId, text) {
  emit({ method: "item/agent_message", params: { turnId, text } });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseArgs(args) {
  const parsed = {
    lettaBin: process.env.LETTA_BIN || "letta",
    backend: process.env.LETTA_BACKEND || "local",
    listenUrl: process.env.LETTA_APP_SERVER_LISTEN || "ws://127.0.0.1:0",
    appServerUrl: process.env.LETTA_APP_SERVER_URL || "",
    permissionMode: process.env.LETTA_CODEX_BRIDGE_PERMISSION_MODE || "",
    workflow: process.env.LETTA_CODEX_BRIDGE_WORKFLOW || "plan-execute-review",
    skillSources: (
      process.env.LETTA_CODEX_BRIDGE_SKILL_SOURCES ||
      "bundled,global,agent,project"
    )
      .split(",")
      .filter(Boolean),
    requestTimeoutMs: Number(
      process.env.LETTA_CODEX_BRIDGE_REQUEST_TIMEOUT_MS || 30_000,
    ),
    turnTimeoutMs: Number(
      process.env.LETTA_CODEX_BRIDGE_TURN_TIMEOUT_MS || 1_800_000,
    ),
    serverStartTimeoutMs: Number(
      process.env.LETTA_CODEX_BRIDGE_SERVER_START_TIMEOUT_MS || 30_000,
    ),
    serverShutdownTimeoutMs: Number(
      process.env.LETTA_CODEX_BRIDGE_SERVER_SHUTDOWN_TIMEOUT_MS || 5_000,
    ),
    maxReportChars: Number(
      process.env.LETTA_CODEX_BRIDGE_MAX_REPORT_CHARS || 60_000,
    ),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => args[++index];
    if (arg === "--agent") parsed.agentId = next();
    else if (arg === "--name" || arg === "--shared-agent")
      parsed.agentName = next();
    else if (arg === "--letta-bin") parsed.lettaBin = next();
    else if (arg === "--backend") parsed.backend = next();
    else if (arg === "--listen") parsed.listenUrl = next();
    else if (arg === "--app-server-url") parsed.appServerUrl = next();
    else if (arg === "--permission-mode") parsed.permissionMode = next();
    else if (arg === "--workflow") parsed.workflow = next();
    else if (arg === "--turn-timeout-ms") parsed.turnTimeoutMs = Number(next());
    else if (arg === "--help" || arg === "-h") usage();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (parsed.agentId && parsed.agentName)
    throw new Error(
      "Use either --agent <id> or --shared-agent <name>, not both",
    );

  parsed.agentLabel = parsed.agentId
    ? `agent ${parsed.agentId}`
    : parsed.agentName
      ? `agent ${parsed.agentName}`
      : "";
  return parsed;
}

function respond(id, result) {
  if (id === undefined || id === null) return;
  emit({ id, result });
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function formatError(error) {
  return error?.stack || error?.message || String(error);
}

function usage() {
  process.stdout.write(
    `Usage: codex-bridge [options]\n\nOptions:\n  --shared-agent <name>        Stable Letta agent name shared by Symphony services\n  --agent <id>                 Letta agent id to run\n  --name <name>                Alias for --shared-agent\n  --app-server-url <url>       Existing Letta App Server WebSocket URL\n  --listen <url>               Spawn local letta server --listen URL, default ws://127.0.0.1:0\n  --letta-bin <path>           Letta executable, default letta from PATH\n  --backend <local|cloud>      Letta backend, default local\n  --workflow <mode>            plan-execute-review or single\n  --permission-mode <mode>     Letta runtime permission mode\n`,
  );
  process.exit(0);
}
