defmodule SymphonyElixir.Plane.Client do
  @moduledoc """
  Thin Plane REST client for polling and mutating project work items.
  """

  require Logger

  alias SymphonyElixir.Config
  alias SymphonyElixir.Tracker.Issue

  @user_agent "symphony"
  @page_size 100

  @type settings :: %{
          base_url: String.t(),
          api_key: String.t(),
          workspace_slug: String.t(),
          project_id: String.t() | nil,
          project_identifier: String.t() | nil,
          claim_state: String.t() | nil,
          terminal_states: [String.t()]
        }

  @spec validate_settings(map()) :: :ok | {:error, term()}
  def validate_settings(tracker_settings) do
    with {:ok, _settings} <- settings(tracker_settings), do: :ok
  end

  @spec secret_environment_names(map()) :: [String.t()]
  def secret_environment_names(tracker_settings) do
    provider = provider_settings(tracker_settings)

    ["PLANE_API_KEY" | env_reference_names([provider["api_key"]])]
    |> Enum.uniq()
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_states(state_names) when is_list(state_names) do
    fetch_issues_by_states(state_names, Config.settings!().tracker, &perform_request/5)
  end

  @spec fetch_issues_by_ids([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_ids(issue_ids) when is_list(issue_ids) do
    fetch_issues_by_ids(issue_ids, Config.settings!().tracker, &perform_request/5)
  end

  @spec claim_issue(Issue.t()) :: {:ok, Issue.t()} | {:error, term()}
  def claim_issue(%Issue{} = issue) do
    claim_issue(issue, Config.settings!().tracker, &perform_request/5)
  end

  @spec request(String.t(), String.t(), map(), term(), keyword()) ::
          {:ok, %{status: integer(), body: term()}} | {:error, term()}
  def request(method, path, params, body, opts \\ [])
      when is_binary(method) and is_binary(path) and is_map(params) and is_list(opts) do
    tracker_settings = Keyword.get_lazy(opts, :tracker_settings, fn -> Config.settings!().tracker end)
    request_fun = Keyword.get(opts, :request_fun, &perform_request/5)

    with {:ok, plane_settings} <- settings(tracker_settings) do
      request_fun.(method, path, params, body, plane_settings)
    end
  end

  @doc false
  @spec fetch_issues_by_states_for_test([String.t()], map(), function()) ::
          {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_states_for_test(state_names, tracker_settings, request_fun)
      when is_list(state_names) and is_map(tracker_settings) and is_function(request_fun, 5) do
    fetch_issues_by_states(state_names, tracker_settings, request_fun)
  end

  @doc false
  @spec fetch_issues_by_ids_for_test([String.t()], map(), function()) ::
          {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_ids_for_test(issue_ids, tracker_settings, request_fun)
      when is_list(issue_ids) and is_map(tracker_settings) and is_function(request_fun, 5) do
    fetch_issues_by_ids(issue_ids, tracker_settings, request_fun)
  end

  @doc false
  @spec claim_issue_for_test(Issue.t(), map(), function()) :: {:ok, Issue.t()} | {:error, term()}
  def claim_issue_for_test(%Issue{} = issue, tracker_settings, request_fun)
      when is_map(tracker_settings) and is_function(request_fun, 5) do
    claim_issue(issue, tracker_settings, request_fun)
  end

  defp fetch_issues_by_states([], _tracker_settings, _request_fun), do: {:ok, []}

  defp fetch_issues_by_states(state_names, tracker_settings, request_fun) do
    requested_states = state_names |> Enum.map(&normalize_state/1) |> MapSet.new()

    with {:ok, plane_settings} <- settings(tracker_settings),
         {:ok, project} <- resolve_project(plane_settings, request_fun),
         {:ok, states_by_id} <- fetch_states_by_id(plane_settings, project.id, request_fun) do
      fetch_work_item_pages(
        plane_settings,
        project,
        states_by_id,
        requested_states,
        request_fun,
        nil,
        []
      )
    end
  end

  defp fetch_issues_by_ids([], _tracker_settings, _request_fun), do: {:ok, []}

  defp fetch_issues_by_ids(issue_ids, tracker_settings, request_fun) do
    ids = Enum.uniq(issue_ids)

    with :ok <- validate_issue_ids(ids),
         {:ok, plane_settings} <- settings(tracker_settings),
         {:ok, project} <- resolve_project(plane_settings, request_fun),
         {:ok, states_by_id} <- fetch_states_by_id(plane_settings, project.id, request_fun) do
      fetch_issue_ids(ids, plane_settings, project, states_by_id, request_fun, [])
    end
  end

  defp claim_issue(%Issue{id: issue_id}, tracker_settings, request_fun) when is_binary(issue_id) do
    with :ok <- validate_issue_ids([issue_id]),
         {:ok, plane_settings} <- settings(tracker_settings),
         true <- present_string?(plane_settings.claim_state) or {:error, :missing_plane_claim_state},
         {:ok, project} <- resolve_project(plane_settings, request_fun),
         {:ok, states_by_id} <- fetch_states_by_id(plane_settings, project.id, request_fun),
         {:ok, claim_state_id} <- claim_state_id(states_by_id, plane_settings.claim_state),
         {:ok, payload} <-
           request_with_settings(
             "PATCH",
             project_work_item_path(plane_settings, project.id, issue_id),
             %{},
             %{"state" => claim_state_id},
             plane_settings,
             request_fun,
             false
           ) do
      case normalize_issue_with_comments(payload, plane_settings, project, states_by_id, request_fun) do
        %Issue{} = issue -> {:ok, issue}
        nil -> {:error, :plane_unknown_payload}
      end
    end
  end

  defp resolve_project(%{project_id: project_id, project_identifier: project_identifier}, _request_fun)
       when is_binary(project_id) do
    {:ok, %{id: project_id, identifier: project_identifier}}
  end

  defp resolve_project(settings, request_fun) do
    path = workspace_projects_path(settings)

    with {:ok, payload} <-
           request_with_settings("GET", path, %{"per_page" => @page_size}, nil, settings, request_fun, false),
         {:ok, projects} <- results_list(payload) do
      projects
      |> Enum.find(&(normalize_identifier(&1["identifier"]) == normalize_identifier(settings.project_identifier)))
      |> case do
        %{"id" => id, "identifier" => identifier} when is_binary(id) ->
          {:ok, %{id: id, identifier: identifier}}

        _ ->
          {:error, :plane_project_not_found}
      end
    end
  end

  defp fetch_states_by_id(settings, project_id, request_fun) do
    path = project_states_path(settings, project_id)

    with {:ok, payload} <-
           request_with_settings("GET", path, %{"per_page" => @page_size}, nil, settings, request_fun, false),
         {:ok, states} <- results_list(payload) do
      {:ok,
       states
       |> Enum.flat_map(fn
         %{"id" => id, "name" => name} when is_binary(id) and is_binary(name) -> [{id, name}]
         _ -> []
       end)
       |> Map.new()}
    end
  end

  defp claim_state_id(states_by_id, claim_state) do
    normalized_claim_state = normalize_state(claim_state)

    states_by_id
    |> Enum.find(fn {_id, name} -> normalize_state(name) == normalized_claim_state end)
    |> case do
      {id, _name} -> {:ok, id}
      nil -> {:error, :plane_state_not_found}
    end
  end

  defp fetch_work_item_pages(
         settings,
         project,
         states_by_id,
         requested_states,
         request_fun,
         cursor,
         acc
       ) do
    params = %{"per_page" => @page_size}
    params = if is_nil(cursor), do: params, else: Map.put(params, "cursor", cursor)

    with {:ok, payload} <-
           request_with_settings(
             "GET",
             project_work_items_path(settings, project.id),
             params,
             nil,
             settings,
             request_fun,
             false
           ),
         {:ok, results} <- results_list(payload) do
      updated_acc = [results | acc]

      if payload_next_page?(payload) do
        fetch_work_item_pages(
          settings,
          project,
          states_by_id,
          requested_states,
          request_fun,
          payload["next_cursor"],
          updated_acc
        )
      else
        {:ok,
         updated_acc
         |> Enum.reverse()
         |> List.flatten()
         |> normalize_work_items(settings, project, states_by_id, requested_states, request_fun)}
      end
    end
  end

  defp fetch_issue_ids([], _settings, _project, _states_by_id, _request_fun, acc), do: {:ok, Enum.reverse(acc)}

  defp fetch_issue_ids([id | rest], settings, project, states_by_id, request_fun, acc) do
    with {:ok, payload} <-
           request_with_settings(
             "GET",
             project_work_item_path(settings, project.id, id),
             %{},
             nil,
             settings,
             request_fun,
             true
           ) do
      continue_fetch_issue_ids(payload, rest, settings, project, states_by_id, request_fun, acc)
    end
  end

  defp continue_fetch_issue_ids(:not_found, rest, settings, project, states_by_id, request_fun, acc) do
    fetch_issue_ids(rest, settings, project, states_by_id, request_fun, acc)
  end

  defp continue_fetch_issue_ids(%{} = raw_issue, rest, settings, project, states_by_id, request_fun, acc) do
    case normalize_issue_with_comments(raw_issue, settings, project, states_by_id, request_fun) do
      %Issue{} = issue -> fetch_issue_ids(rest, settings, project, states_by_id, request_fun, [issue | acc])
      nil -> {:error, :plane_unknown_payload}
    end
  end

  defp continue_fetch_issue_ids(_payload, _rest, _settings, _project, _states_by_id, _request_fun, _acc) do
    {:error, :plane_unknown_payload}
  end

  defp normalize_work_items(results, settings, project, states_by_id, requested_states, request_fun) do
    issues = Enum.map(results, &normalize_issue(&1, settings, project, states_by_id))
    malformed_count = Enum.count(issues, &is_nil/1)

    if malformed_count > 0 do
      Logger.warning("Dropping malformed Plane work item records count=#{malformed_count}")
    end

    issues
    |> Enum.reject(&is_nil/1)
    |> apply_subtask_blockers(settings)
    |> Enum.filter(&MapSet.member?(requested_states, normalize_state(&1.state)))
    |> Enum.map(&hydrate_active_issue(&1, settings, project, states_by_id, request_fun))
  end

  defp hydrate_active_issue(%Issue{} = issue, settings, project, states_by_id, request_fun) do
    if terminal_state?(issue.state, settings) do
      issue
    else
      issue
      |> hydrate_comments(settings, project.id, request_fun)
      |> hydrate_relations(settings, project, states_by_id, request_fun)
    end
  end

  defp normalize_issue_with_comments(raw_issue, settings, project, states_by_id, request_fun) do
    case normalize_issue(raw_issue, settings, project, states_by_id) do
      %Issue{} = issue ->
        issue
        |> hydrate_comments(settings, project.id, request_fun)
        |> hydrate_relations(settings, project, states_by_id, request_fun)

      nil ->
        nil
    end
  end

  defp hydrate_comments(%Issue{id: issue_id} = issue, settings, project_id, request_fun) do
    case fetch_comments(settings, project_id, issue_id, request_fun) do
      {:ok, []} ->
        issue

      {:ok, comments} ->
        %{issue | comments: comments, description: append_comments(issue.description, comments)}

      {:error, reason} ->
        Logger.warning("Plane comment fetch failed issue_id=#{issue_id} reason=#{inspect(reason)}")
        issue
    end
  end

  defp normalize_issue(issue, settings, project, states_by_id) when is_map(issue) do
    id = issue["id"]
    title = issue["name"]
    state_name = Map.get(states_by_id, issue["state"])
    sequence_id = issue["sequence_id"]
    project_identifier = project.identifier || settings.project_identifier

    if present_string?(id) and present_string?(title) and present_string?(state_name) and
         present_string?(project_identifier) and is_integer(sequence_id) do
      %Issue{
        id: id,
        native_ref:
          %{
            "id" => id,
            "workspace_slug" => settings.workspace_slug,
            "project_id" => project.id,
            "project_identifier" => project_identifier,
            "sequence_id" => sequence_id
          }
          |> maybe_put_parent_id(issue["parent"]),
        identifier: "#{project_identifier}-#{sequence_id}",
        title: title,
        description: issue["description_html"] || issue["description_text"] || issue["description"],
        priority: normalize_priority(issue["priority"]),
        state: state_name,
        url: issue_url(settings, project_identifier, sequence_id),
        assignee_id: assignee_id(issue),
        comments: [],
        labels: extract_labels(issue),
        blocked_by: [],
        dispatchable: not terminal_state?(state_name, settings),
        created_at: parse_datetime(issue["created_at"]),
        updated_at: parse_datetime(issue["updated_at"])
      }
    end
  end

  defp normalize_issue(_issue, _settings, _project, _states_by_id), do: nil

  defp apply_subtask_blockers(issues, settings) do
    blockers_by_parent_id =
      issues
      |> Enum.reject(&terminal_state?(&1.state, settings))
      |> Enum.group_by(&get_in(&1.native_ref, ["parent_id"]), &subtask_blocker/1)
      |> Map.delete(nil)

    Enum.map(issues, fn issue ->
      case Map.get(blockers_by_parent_id, issue.id, []) do
        [] ->
          issue

        blockers ->
          %{issue | blocked_by: unique_blockers(issue.blocked_by ++ blockers), dispatchable: false}
      end
    end)
  end

  defp subtask_blocker(%Issue{} = issue) do
    %{
      "id" => issue.id,
      "identifier" => issue.identifier,
      "project_id" => get_in(issue.native_ref, ["project_id"]),
      "state" => issue.state,
      "title" => issue.title
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp unique_blockers(blockers) do
    Enum.uniq_by(blockers, fn blocker -> {blocker["project_id"], blocker["id"], blocker["identifier"]} end)
  end

  defp maybe_put_parent_id(native_ref, parent_id) when is_binary(parent_id) and parent_id != "" do
    Map.put(native_ref, "parent_id", parent_id)
  end

  defp maybe_put_parent_id(native_ref, _parent_id), do: native_ref

  defp fetch_comments(settings, project_id, issue_id, request_fun) do
    with {:ok, payload} <-
           request_with_settings(
             "GET",
             project_work_item_comments_path(settings, project_id, issue_id),
             %{"per_page" => @page_size},
             nil,
             settings,
             request_fun,
             true
           ) do
      case payload do
        :not_found -> {:ok, []}
        payload -> payload |> results_list() |> normalize_comments()
      end
    end
  end

  defp normalize_comments({:ok, comments}) do
    {:ok,
     comments
     |> Enum.map(&normalize_comment/1)
     |> Enum.reject(&is_nil/1)}
  end

  defp normalize_comments({:error, reason}), do: {:error, reason}

  defp hydrate_relations(%Issue{id: issue_id} = issue, settings, project, states_by_id, request_fun) do
    case fetch_relations(settings, project.id, issue_id, states_by_id, request_fun) do
      {:ok, blocked_by} ->
        combined_blockers = unique_blockers(issue.blocked_by ++ blocked_by)

        %{
          issue
          | blocked_by: combined_blockers,
            dispatchable: issue.dispatchable and combined_blockers == []
        }

      {:error, reason} ->
        Logger.warning("Plane relation fetch failed issue_id=#{issue_id} reason=#{inspect(reason)}")
        issue
    end
  end

  defp fetch_relations(settings, project_id, issue_id, states_by_id, request_fun) do
    with {:ok, payload} <-
           request_with_settings(
             "GET",
             project_work_item_relations_path(settings, project_id, issue_id),
             %{},
             nil,
             settings,
             request_fun,
             true
           ) do
      case payload do
        :not_found -> {:ok, []}
        %{"blocked_by" => blocked_by} when is_list(blocked_by) -> {:ok, normalize_blockers(blocked_by, settings, states_by_id, request_fun)}
        _payload -> {:error, :plane_unknown_payload}
      end
    end
  end

  defp normalize_blockers(blocked_by, settings, states_by_id, request_fun) do
    blocked_by
    |> Enum.map(&normalize_blocker(&1, settings, states_by_id, request_fun))
    |> Enum.reject(&is_nil/1)
    |> Enum.reject(&terminal_blocker?(&1, settings))
  end

  defp terminal_blocker?(%{"state" => state_name}, settings) when is_binary(state_name),
    do: terminal_state?(state_name, settings)

  defp terminal_blocker?(_blocker, _settings), do: false

  defp normalize_blocker(%{"issue_id" => issue_id, "project_id" => project_id}, settings, states_by_id, request_fun)
       when is_binary(issue_id) and is_binary(project_id) do
    case request_with_settings(
           "GET",
           project_work_item_path(settings, project_id, issue_id),
           %{},
           nil,
           settings,
           request_fun,
           true
         ) do
      {:ok, %{} = blocker} ->
        blocker
        |> Map.put_new("project_id", project_id)
        |> normalize_blocker_details(settings, states_by_id)

      _ ->
        %{"id" => issue_id, "project_id" => project_id}
    end
  end

  defp normalize_blocker(blocker, settings, states_by_id, _request_fun),
    do: normalize_blocker_details(blocker, settings, states_by_id)

  defp normalize_blocker_details(%{"id" => id, "sequence_id" => sequence_id} = blocker, settings, states_by_id)
       when is_binary(id) and is_integer(sequence_id) do
    project_identifier = normalize_string(blocker["project_identifier"]) || settings.project_identifier

    %{
      "id" => id,
      "identifier" => "#{project_identifier}-#{sequence_id}",
      "project_id" => normalize_string(blocker["project_id"]),
      "state" => blocker_state_name(blocker, states_by_id),
      "title" => normalize_string(blocker["name"])
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp normalize_blocker_details(_blocker, _settings, _states_by_id), do: nil

  defp blocker_state_name(%{"state" => state_id}, states_by_id) when is_binary(state_id), do: Map.get(states_by_id, state_id)
  defp blocker_state_name(%{"state" => %{"name" => state_name}}, _states_by_id), do: normalize_string(state_name)
  defp blocker_state_name(_blocker, _states_by_id), do: nil

  defp normalize_comment(comment) when is_map(comment) do
    body = comment["comment_html"] || comment["comment_stripped"] || comment["comment"] || comment["body"]

    if present_string?(body) do
      %{
        "body" => body,
        "created_at" => normalize_string(comment["created_at"]),
        "id" => normalize_string(comment["id"])
      }
      |> Enum.reject(fn {_key, value} -> is_nil(value) end)
      |> Map.new()
    end
  end

  defp normalize_comment(_comment), do: nil

  defp append_comments(description, comments) do
    comment_text =
      comments
      |> Enum.map(fn comment ->
        created_at = Map.get(comment, "created_at", "unknown time")
        body = Map.get(comment, "body", "")
        "- #{created_at}: #{body}"
      end)
      |> Enum.join("\n")

    [blank_to_nil(description), "Tracker comments:\n" <> comment_text]
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n\n")
  end

  defp blank_to_nil(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp blank_to_nil(_value), do: nil

  defp request_with_settings(method, path, params, body, settings, request_fun, allow_not_found) do
    case request_fun.(method, path, params, body, settings) do
      {:ok, %{status: status, body: payload}} when status in 200..299 ->
        {:ok, payload}

      {:ok, %{status: 404}} when allow_not_found ->
        {:ok, :not_found}

      {:ok, %{status: status}} when is_integer(status) ->
        Logger.error("Plane API request failed status=#{status} method=#{method} path=#{path}")
        {:error, {:plane_api_status, status}}

      {:error, reason} ->
        {:error, reason}

      _ ->
        {:error, :plane_unknown_payload}
    end
  end

  defp perform_request(method, path, params, body, settings) do
    with {:ok, request_method} <- request_method(method) do
      request_opts = [
        method: request_method,
        url: settings.base_url <> path,
        headers: plane_headers(settings.api_key),
        params: params,
        connect_options: [timeout: 30_000]
      ]

      request_opts = if is_nil(body), do: request_opts, else: Keyword.put(request_opts, :json, body)

      case Req.request(request_opts) do
        {:ok, response} -> {:ok, %{status: response.status, body: response.body}}
        {:error, reason} -> {:error, {:plane_api_request, reason}}
      end
    end
  end

  defp settings(tracker_settings) when is_map(tracker_settings) do
    provider = provider_settings(tracker_settings)
    settings = build_settings(tracker_settings, provider)

    with :ok <- validate_plane_settings(settings) do
      {:ok, %{settings | base_url: String.trim_trailing(settings.base_url, "/")}}
    end
  end

  defp build_settings(tracker_settings, provider) do
    %{
      base_url: resolve_setting(provider["base_url"] || provider["url"], nil),
      api_key: resolve_setting(provider["api_key"], tracker_value(tracker_settings, :api_key) || System.get_env("PLANE_API_KEY")),
      workspace_slug: resolve_setting(provider["workspace_slug"], nil),
      project_id: resolve_setting(provider["project_id"], nil),
      project_identifier: resolve_setting(provider["project_identifier"], nil),
      claim_state: resolve_setting(provider["claim_state"], "In Progress"),
      terminal_states: tracker_value(tracker_settings, :terminal_states) || []
    }
  end

  defp tracker_value(tracker_settings, key) when is_map(tracker_settings), do: Map.get(tracker_settings, key)

  defp validate_plane_settings(settings) do
    cond do
      is_nil(settings.base_url) -> {:error, :missing_plane_base_url}
      not valid_base_url?(settings.base_url) -> {:error, :invalid_plane_base_url}
      not present_string?(settings.api_key) -> {:error, :missing_plane_api_key}
      not present_string?(settings.workspace_slug) -> {:error, :missing_plane_workspace_slug}
      true -> validate_project_scope(settings)
    end
  end

  defp validate_project_scope(settings) do
    cond do
      not is_nil(settings.project_id) and not valid_uuid?(settings.project_id) ->
        {:error, :invalid_plane_project_id}

      not present_string?(settings.project_id) and not present_string?(settings.project_identifier) ->
        {:error, :missing_plane_project_scope}

      true ->
        :ok
    end
  end

  defp provider_settings(%{provider: provider}) when is_map(provider), do: provider
  defp provider_settings(_tracker_settings), do: %{}

  defp resolve_setting(nil, fallback), do: normalize_string(fallback)

  defp resolve_setting("$" <> env_name, fallback) do
    if valid_env_name?(env_name) do
      normalize_string(System.get_env(env_name) || fallback)
    else
      nil
    end
  end

  defp resolve_setting(value, _fallback), do: normalize_string(value)

  defp normalize_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_string(_value), do: nil

  defp env_reference_names(values) do
    Enum.flat_map(values, fn
      "$" <> env_name when is_binary(env_name) -> if valid_env_name?(env_name), do: [env_name], else: []
      _ -> []
    end)
  end

  defp valid_env_name?(name), do: String.match?(name, ~r/^[A-Za-z_][A-Za-z0-9_]*$/)

  defp valid_base_url?(value) when is_binary(value) do
    case URI.parse(value) do
      %URI{scheme: scheme, host: host} when scheme in ["http", "https"] and is_binary(host) -> true
      _ -> false
    end
  end

  defp valid_base_url?(_value), do: false

  defp valid_uuid?(value) when is_binary(value), do: String.match?(value, ~r/^[0-9a-fA-F-]{36}$/)
  defp valid_uuid?(_value), do: false

  defp plane_headers(api_key) do
    [
      {"Accept", "application/json"},
      {"X-Api-Key", api_key},
      {"User-Agent", @user_agent}
    ]
  end

  defp request_method("GET"), do: {:ok, :get}
  defp request_method("POST"), do: {:ok, :post}
  defp request_method("PATCH"), do: {:ok, :patch}
  defp request_method("PUT"), do: {:ok, :put}
  defp request_method("DELETE"), do: {:ok, :delete}
  defp request_method(_method), do: {:error, :invalid_plane_method}

  defp workspace_projects_path(settings), do: "/api/v1/workspaces/#{encoded(settings.workspace_slug)}/projects/"

  defp project_states_path(settings, project_id),
    do: "/api/v1/workspaces/#{encoded(settings.workspace_slug)}/projects/#{project_id}/states/"

  defp project_work_items_path(settings, project_id),
    do: "/api/v1/workspaces/#{encoded(settings.workspace_slug)}/projects/#{project_id}/work-items/"

  defp project_work_item_path(settings, project_id, issue_id),
    do: "/api/v1/workspaces/#{encoded(settings.workspace_slug)}/projects/#{project_id}/work-items/#{issue_id}/"

  defp project_work_item_comments_path(settings, project_id, issue_id),
    do: "/api/v1/workspaces/#{encoded(settings.workspace_slug)}/projects/#{project_id}/work-items/#{issue_id}/comments/"

  defp project_work_item_relations_path(settings, project_id, issue_id),
    do: "/api/v1/workspaces/#{encoded(settings.workspace_slug)}/projects/#{project_id}/work-items/#{issue_id}/relations/"

  defp results_list(%{"results" => results}) when is_list(results), do: {:ok, results}
  defp results_list(results) when is_list(results), do: {:ok, results}
  defp results_list(_payload), do: {:error, :plane_unknown_payload}

  defp payload_next_page?(%{"next_page_results" => true, "next_cursor" => cursor}), do: present_string?(cursor)
  defp payload_next_page?(_payload), do: false

  defp validate_issue_ids(ids) do
    if Enum.all?(ids, &valid_uuid?/1), do: :ok, else: {:error, :invalid_plane_issue_id}
  end

  defp normalize_identifier(value) when is_binary(value), do: value |> String.trim() |> String.upcase()
  defp normalize_identifier(_value), do: ""

  defp normalize_state(value) when is_binary(value), do: value |> String.trim() |> String.downcase()
  defp normalize_state(_value), do: ""

  defp terminal_state?(state_name, tracker_settings) do
    terminal_states = tracker_settings.terminal_states || []
    MapSet.member?(MapSet.new(terminal_states, &normalize_state/1), normalize_state(state_name))
  end

  defp normalize_priority(value) when is_integer(value), do: value

  defp normalize_priority(value) when is_binary(value) do
    case normalize_state(value) do
      "urgent" -> 1
      "high" -> 2
      "medium" -> 3
      "low" -> 4
      _priority -> nil
    end
  end

  defp normalize_priority(_value), do: nil

  defp assignee_id(%{"assignees" => [%{"id" => id} | _]}) when is_binary(id), do: id
  defp assignee_id(%{"assignees" => [id | _]}) when is_binary(id), do: id
  defp assignee_id(_issue), do: nil

  defp extract_labels(%{"labels" => labels}) when is_list(labels) do
    labels
    |> Enum.flat_map(fn
      %{"name" => name} when is_binary(name) -> [name]
      name when is_binary(name) -> [name]
      _ -> []
    end)
    |> Enum.map(&(String.trim(&1) |> String.downcase()))
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  defp extract_labels(_issue), do: []

  defp parse_datetime(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, datetime, _offset} -> datetime
      _ -> nil
    end
  end

  defp parse_datetime(_value), do: nil

  defp issue_url(settings, project_identifier, sequence_id) do
    "#{settings.base_url}/#{settings.workspace_slug}/browse/#{project_identifier}-#{sequence_id}"
  end

  defp encoded(value), do: URI.encode(value, &URI.char_unreserved?/1)

  defp present_string?(value) when is_binary(value), do: String.trim(value) != ""
  defp present_string?(_value), do: false
end
