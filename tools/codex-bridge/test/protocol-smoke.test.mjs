import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { bridgeTestHooks } from "../bin/codex-bridge.mjs";

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

  child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: process.cwd() } }) + "\n");
  await waitFor(() => lines.length >= 2, 2_000, () => stderr);
  child.stdin.end();

  assert.equal(lines[0].id, 1);
  assert.equal(lines[1].result.thread.id, "local");

  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
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
