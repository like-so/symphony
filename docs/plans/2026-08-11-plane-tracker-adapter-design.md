# Plane Tracker Adapter Design

**Goal:** Add first-class `tracker.kind: plane` support so Symphony can use a self-hosted Plane workspace/project as an issue tracker.

**Approved Approach:** Implement a Plane-specific tracker adapter, not a read-only adapter or a generic REST tracker.

## Configuration

Plane configuration belongs under `tracker.provider`:

```yaml
tracker:
  kind: plane
  provider:
    base_url: http://k8s-mac-003.brill-polaris.ts.net
    api_key: $PLANE_API_KEY
    workspace_slug: plane
    project_identifier: NAUTILUS
    claim_state: In Progress
```

The adapter also accepts `project_id` to skip project identifier resolution. `api_key` supports `$ENV_NAME` references and defaults to `PLANE_API_KEY` when omitted. `base_url` must be HTTP or HTTPS and is normalized without a trailing slash.

Default state mapping:

```text
active_states:   Todo, In Progress
terminal_states: Done, Cancelled, Canceled
claim_state:     In Progress
```

## Architecture

Add three modules matching existing tracker patterns:

- `SymphonyElixir.Plane.Adapter`: tracker behaviour implementation, config validation, read delegation, `plane_api` exposure, and secret env declaration.
- `SymphonyElixir.Plane.Client`: Plane REST calls, settings resolution, project/state resolution, pagination, issue normalization, and claim-state updates.
- `SymphonyElixir.Plane.AgentTool`: host-side raw Plane REST tool for Codex app-server turns.

Register the adapter in `SymphonyElixir.Tracker` and extend config finalization in `SymphonyElixir.Config.Schema` for Plane defaults and secret resolution.

## Data Flow

Candidate polling calls:

```text
GET /api/v1/workspaces/{workspace_slug}/projects/{project_id}/work-items/
```

When `project_id` is absent, the client resolves it by listing projects and matching `project_identifier`. It resolves states by listing project states and maps the Plane state UUID in each work item back to a state name.

Normalized issue mapping:

```text
id          Plane work item UUID
identifier  {project_identifier}-{sequence_id}, for example NAUTILUS-1
title       name
description description_html, falling back to description_text/description
state       resolved Plane state name
priority    nil unless Plane returns an integer-like value
labels      label names, normalized lower-case
url         best-effort Plane web URL
native_ref  Plane ids, workspace slug, project id, project identifier, sequence id
```

Claiming is added through an optional adapter callback and a generic `Tracker.claim_issue/1` wrapper. Adapters without claim support return the original issue unchanged. The Plane adapter PATCHes the work item `state` to the configured `claim_state` UUID and returns the refreshed issue.

## Error Handling

Use explicit atoms consistent with existing adapters:

```text
:missing_plane_base_url
:invalid_plane_base_url
:missing_plane_api_key
:missing_plane_workspace_slug
:missing_plane_project_scope
:invalid_plane_project_id
:missing_plane_claim_state
{:plane_api_status, status}
{:plane_api_request, reason}
:plane_unknown_payload
:plane_project_not_found
:plane_state_not_found
```

Tool failures return JSON payloads with `success: false`, matching other dynamic tracker tools.

## Testing

Unit tests cover config validation, env secret resolution, URL safety, project resolution, state resolution, pagination, normalization, claim-state PATCH, `plane_api` argument validation, adapter registration, and secret stripping.

Live smoke against the local Plane instance uses a temporary API token and temporary work item in workspace `plane` project `nautilus`. It verifies project reads, candidate reads, claim to `In Progress`, refresh by id, and cleanup.

## Non-Goals

- Do not implement full Plane UI automation.
- Do not build a generic REST tracker abstraction.
- Do not add Plane-specific orchestration policy outside the adapter boundary.
- Do not persist local Plane credentials in repo files.
