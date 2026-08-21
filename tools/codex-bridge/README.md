# codex-bridge

`codex-bridge` is a stdio adapter for running Codex-compatible Letta Code agents
behind a Symphony `codex.command` without modifying Symphony.

Symphony still talks to what looks like a minimal Codex app-server process. The
bridge accepts the app-server messages Symphony sends, opens a Letta App Server
WebSocket runtime for the selected agent, runs a plan/execute/review input loop,
and emits Codex-like completion events back to Symphony.

## Example Symphony config

```yaml
codex:
  command: >-
    /path/to/codex-bridge/bin/codex-bridge.mjs
    --letta-bin letta
    --agent agent-local-d6362060-64cf-4175-acac-9cad1fc0f419
    --backend local
    --workflow plan-execute-review
```

Use `--name Snowl` instead of `--agent ...` to resolve an exact local agent name
through `letta agents list --name` before running the turn.

## Runtime Model

- The bridge starts `letta server --backend local --listen ws://127.0.0.1:0` unless
  `--app-server-url <url>` points to an existing Letta App Server.
- Each Symphony turn creates a fresh Letta conversation for isolation from the
  Discord conversation currently using the same agent.
- Letta agent memory is still shared because the runtime starts the selected
  stateful agent by `agent_id`.
- The bridge can select different Letta agents with `--agent <id>` or
  `--name <name>`.
- `--workflow plan-execute-review` sends three sequential inputs to the same
  isolated Letta runtime conversation: planning, execution, then review.
- `--workflow single` sends only one execution input.

## App Server lifecycle

A locally spawned App Server is owned by the Symphony turn that created it. The
bridge terminates the complete App Server process group when the turn finishes,
fails, or the bridge shuts down. Shutdown sends `SIGTERM`, waits for a bounded
grace period, and escalates to `SIGKILL` when necessary. An App Server supplied
with `--app-server-url` is borrowed and is never terminated by the bridge.
