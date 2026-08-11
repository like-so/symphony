# Plane Tracker Adapter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `tracker.kind: plane` so Symphony can poll, claim, and expose tools for a self-hosted Plane project.

**Architecture:** Add Plane adapter, client, and dynamic tool modules following existing GitHub/GitLab patterns. Extend tracker registration and config normalization for Plane defaults, `$PLANE_API_KEY` resolution, and secret stripping. Add a generic optional claim wrapper so Plane can move a work item to `In Progress` before Symphony launches a worker.

**Tech Stack:** Elixir 1.19/OTP 28, Req, Jason, Ecto config schema, ExUnit, existing Symphony tracker behaviour.

---

### Task 1: Register Plane Config Defaults

**Files:**
- Modify: `elixir/lib/symphony_elixir/config/schema.ex`
- Test: `elixir/test/symphony_elixir/workspace_and_config_test.exs`

**Step 1: Write the failing test**

Add a config parsing test for:

```elixir
%{
  "tracker" => %{
    "kind" => "plane",
    "provider" => %{
      "base_url" => "http://plane.local/",
      "api_key" => "$PLANE_API_KEY",
      "workspace_slug" => "plane",
      "project_identifier" => "NAUTILUS",
      "claim_state" => "In Progress"
    }
  }
}
```

Assert Plane defaults and env resolution:

```elixir
settings.tracker.api_key == System.get_env("PLANE_API_KEY")
settings.tracker.active_states == ["Todo", "In Progress"]
settings.tracker.terminal_states == ["Done", "Cancelled", "Canceled"]
settings.tracker.secret_environment_names == ["PLANE_API_KEY"]
```

Also test explicit `active_states` and `terminal_states` overrides are preserved.

**Step 2: Run test to verify it fails**

```bash
cd elixir
mise exec -- mix test test/symphony_elixir/workspace_and_config_test.exs --trace
```

Expected: FAIL because Plane defaults and env resolution do not exist.

**Step 3: Write minimal implementation**

In `SymphonyElixir.Config.Schema`, add Plane active/terminal defaults and a `"plane"` branch in `finalize_settings/1` that resolves provider `api_key` from `$ENV_NAME` or `PLANE_API_KEY`, stores it in `tracker.api_key`, and declares secret env names.

**Step 4: Run test to verify it passes**

Run the same test command. Expected: PASS.

**Step 5: Commit**

```bash
git add elixir/lib/symphony_elixir/config/schema.ex elixir/test/symphony_elixir/workspace_and_config_test.exs
git commit -m 'feat: add plane tracker config defaults'
```

---

### Task 2: Add Plane Client Settings and REST Helper

**Files:**
- Create: `elixir/lib/symphony_elixir/plane/client.ex`
- Test: `elixir/test/symphony_elixir/plane_adapter_test.exs`

**Step 1: Write the failing tests**

Test `validate_settings/1` rejects missing or invalid `base_url`, `api_key`, `workspace_slug`, and missing project scope. Test `secret_environment_names/1` returns `PLANE_API_KEY` plus referenced env names. Test `request/5` sends `X-Api-Key`, JSON body, query params, and normalized base URL to injected `request_fun`.

**Step 2: Run test to verify it fails**

```bash
cd elixir
mise exec -- mix test test/symphony_elixir/plane_adapter_test.exs --trace
```

Expected: FAIL because the module does not exist.

**Step 3: Write minimal implementation**

Create `SymphonyElixir.Plane.Client` with public specs for `validate_settings/1`, `secret_environment_names/1`, `request/5`, and test helpers. Use `%{base_url:, api_key:, workspace_slug:, project_id:, project_identifier:, claim_state:}` internally. Use `Req` in `perform_request/5`.

**Step 4: Run test to verify it passes**

Expected: PASS for settings and request helper tests.

**Step 5: Commit**

```bash
git add elixir/lib/symphony_elixir/plane/client.ex elixir/test/symphony_elixir/plane_adapter_test.exs
git commit -m 'feat: add plane api client settings'
```

---

### Task 3: Implement Plane Issue Reads

**Files:**
- Modify: `elixir/lib/symphony_elixir/plane/client.ex`
- Test: `elixir/test/symphony_elixir/plane_adapter_test.exs`

**Step 1: Write the failing tests**

Cover:

- project identifier `NAUTILUS` resolves to project UUID by listing `/api/v1/workspaces/plane/projects/`.
- states resolve UUID to names from `/states/`.
- state reads call `/work-items/`, follow pagination, filter requested states, and normalize issues.
- id refresh calls `/work-items/<uuid>/`, omits 404s, and rejects malformed payloads.

Use Plane fixture maps based on the live API response.

**Step 2: Run test to verify it fails**

Run the Plane adapter test. Expected: FAIL because reads are missing.

**Step 3: Write minimal implementation**

Implement `fetch_issues_by_states/1`, `fetch_issues_by_ids/1`, and private normalization. Map `sequence_id` to identifiers like `NAUTILUS-1`, and set `dispatchable` when the normalized state is not terminal.

**Step 4: Run test to verify it passes**

Expected: PASS for issue read tests.

**Step 5: Commit**

```bash
git add elixir/lib/symphony_elixir/plane/client.ex elixir/test/symphony_elixir/plane_adapter_test.exs
git commit -m 'feat: read plane work items'
```

---

### Task 4: Add Plane Adapter and Dynamic Tool

**Files:**
- Modify: `elixir/lib/symphony_elixir/tracker.ex`
- Create: `elixir/lib/symphony_elixir/plane/adapter.ex`
- Create: `elixir/lib/symphony_elixir/plane/agent_tool.ex`
- Test: `elixir/test/symphony_elixir/plane_adapter_test.exs`

**Step 1: Write the failing tests**

Test adapter validation delegates to client settings, `Tracker.adapter_for_kind("plane")` returns the Plane adapter, reads delegate to an injectable client module, `plane_api` is advertised, and `plane_api` rejects unsafe paths/methods while preserving REST status/body.

**Step 2: Run test to verify it fails**

Expected: FAIL because adapter/tool are missing.

**Step 3: Write minimal implementation**

Add adapter registration in `SymphonyElixir.Tracker`. Implement `Plane.Adapter` like `GitHub.Adapter`. Implement `Plane.AgentTool` like `GitHub.AgentTool`, but named `plane_api` and using `Plane.Client.request/5`.

**Step 4: Run test to verify it passes**

Expected: PASS.

**Step 5: Commit**

```bash
git add elixir/lib/symphony_elixir/tracker.ex elixir/lib/symphony_elixir/plane/adapter.ex elixir/lib/symphony_elixir/plane/agent_tool.ex elixir/test/symphony_elixir/plane_adapter_test.exs
git commit -m 'feat: expose plane tracker adapter'
```

---

### Task 5: Add Claim-State Support

**Files:**
- Modify: `elixir/lib/symphony_elixir/tracker.ex`
- Modify: `elixir/lib/symphony_elixir/orchestrator.ex`
- Modify: `elixir/lib/symphony_elixir/plane/adapter.ex`
- Modify: `elixir/lib/symphony_elixir/plane/client.ex`
- Test: `elixir/test/symphony_elixir/plane_adapter_test.exs`
- Test: nearest orchestrator dispatch test in `elixir/test/symphony_elixir/`

**Step 1: Write the failing tests**

Test Plane claim resolves `claim_state` to a UUID, PATCHes the work item `state`, and returns the refreshed normalized issue. Test the orchestrator dispatch path uses `Tracker.claim_issue/1` after refresh and before worker launch.

**Step 2: Run test to verify it fails**

Expected: FAIL because claim callback does not exist.

**Step 3: Write minimal implementation**

Add optional callback `claim_issue/1` to `SymphonyElixir.Tracker`. Default to `{:ok, issue}` when the adapter lacks the callback. Add Plane claim implementation. In the orchestrator dispatch path, call `Tracker.claim_issue/1` after refresh revalidation and dispatch the returned issue.

**Step 4: Run test to verify it passes**

Expected: PASS.

**Step 5: Commit**

```bash
git add elixir/lib/symphony_elixir/tracker.ex elixir/lib/symphony_elixir/orchestrator.ex elixir/lib/symphony_elixir/plane/adapter.ex elixir/lib/symphony_elixir/plane/client.ex elixir/test/symphony_elixir/plane_adapter_test.exs elixir/test/symphony_elixir/*orchestrator*.exs
git commit -m 'feat: claim plane work items'
```

---

### Task 6: Documentation and Example

**Files:**
- Modify: `elixir/README.md`
- Modify: `elixir/WORKFLOW.md` or create `elixir/WORKFLOW.plane.example.md`

**Step 1: Write docs update**

Document Plane config:

```yaml
tracker:
  kind: plane
  provider:
    base_url: $PLANE_BASE_URL
    api_key: $PLANE_API_KEY
    workspace_slug: plane
    project_identifier: NAUTILUS
    claim_state: In Progress
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled, Canceled]
```

Document that Symphony uses `/api/v1` with `X-Api-Key` and project UUID/identifier scoping.

**Step 2: Run focused tests**

```bash
cd elixir
mise exec -- mix test test/symphony_elixir/workspace_and_config_test.exs test/symphony_elixir/plane_adapter_test.exs --trace
```

Expected: PASS.

**Step 3: Commit**

```bash
git add elixir/README.md elixir/WORKFLOW.plane.example.md
git commit -m 'docs: document plane tracker adapter'
```

---

### Task 7: Local Plane Smoke Test

**Files:**
- No committed files expected.

**Step 1: Create temporary Plane API token**

Use the running Plane API pod to create a token for `gyunt@plane.local`, export it only in the shell, and delete it after testing.

**Step 2: Create temporary Plane work item**

Create a `Todo` work item in workspace `plane`, project `nautilus`, titled `Symphony Plane adapter smoke`.

**Step 3: Run live smoke**

Verify:

- `Tracker.fetch_issues_by_states(["Todo"])` returns the item.
- `Tracker.claim_issue(issue)` moves it to `In Progress`.
- `Tracker.fetch_issues_by_ids([issue.id])` returns the updated item.

**Step 4: Clean live resources**

Delete the temporary work item and API token. Verify no smoke item remains active and no temporary token remains.

---

### Task 8: Full Verification

**Files:**
- All changed files.

**Step 1: Format**

```bash
cd elixir
mise exec -- mix format
```

**Step 2: Targeted tests**

```bash
cd elixir
mise exec -- mix test test/symphony_elixir/plane_adapter_test.exs test/symphony_elixir/workspace_and_config_test.exs --trace
```

Expected: PASS.

**Step 3: Specs check**

```bash
cd elixir
mise exec -- mix specs.check
```

Expected: PASS.

**Step 4: Full gate if practical**

```bash
cd elixir
mise exec -- make all
```

Expected: PASS. If pre-existing timing failures recur, capture exact output and rerun targeted Plane tests plus `mix specs.check`.

**Step 5: Final status**

Report changed files, verification commands, live Plane smoke result, and remaining limitations.
