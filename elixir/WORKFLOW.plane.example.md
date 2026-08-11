---
tracker:
  kind: plane
  provider:
    base_url: $PLANE_BASE_URL
    api_key: $PLANE_API_KEY
    workspace_slug: plane
    project_identifier: NAUTILUS
    claim_state: In Progress
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
    - Canceled
polling:
  interval_ms: 5000
workspace:
  root: ~/code/symphony-plane-workspaces
hooks:
  after_create: |
    git clone --depth 1 https://github.com/like-so/symphony .
    if command -v mise >/dev/null 2>&1; then
      cd elixir && mise trust && mise exec -- mix deps.get
    fi
agent:
  max_concurrent_agents: 2
  max_turns: 20
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
---

You are working on a Plane work item `{{ issue.identifier }}`.

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. Work only in the provided repository copy.
2. Keep the Plane work item current using the injected `plane_api` tool when useful.
3. Treat `Done`, `Cancelled`, and `Canceled` as terminal states.
4. Report completed actions and blockers only in the final response.
