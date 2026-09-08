defmodule SymphonyElixir.Plane.AdapterTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Config.Schema
  alias SymphonyElixir.Plane.Adapter, as: PlaneAdapter
  alias SymphonyElixir.Plane.AgentTool, as: PlaneAgentTool
  alias SymphonyElixir.Plane.Client, as: PlaneClient
  alias SymphonyElixir.Tracker

  defmodule FakePlaneClient do
    def validate_settings(_settings), do: :ok
    def secret_environment_names(_settings), do: ["PLANE_API_KEY"]

    def fetch_issues_by_states(states) do
      send(self(), {:plane_states_called, states})
      {:ok, states}
    end

    def fetch_issues_by_ids(ids) do
      send(self(), {:plane_ids_called, ids})
      {:ok, ids}
    end

    def claim_issue(issue) do
      send(self(), {:plane_claim_called, issue})
      {:ok, %{issue | state: "In Progress"}}
    end
  end

  setup do
    plane_client_module = Application.get_env(:symphony_elixir, :plane_client_module)

    on_exit(fn ->
      if is_nil(plane_client_module) do
        Application.delete_env(:symphony_elixir, :plane_client_module)
      else
        Application.put_env(:symphony_elixir, :plane_client_module, plane_client_module)
      end
    end)

    :ok
  end

  test "adapter validates Plane config, delegates reads, and advertises plane_api" do
    settings = tracker_settings()

    assert :ok = PlaneAdapter.validate_config(settings)
    Application.put_env(:symphony_elixir, :plane_client_module, FakePlaneClient)

    assert {:ok, ["Todo"]} = PlaneAdapter.fetch_issues_by_states(["Todo"])
    assert_receive {:plane_states_called, ["Todo"]}

    assert {:ok, ["issue-id"]} = PlaneAdapter.fetch_issues_by_ids(["issue-id"])
    assert_receive {:plane_ids_called, ["issue-id"]}

    issue = %SymphonyElixir.Tracker.Issue{id: "issue-id", identifier: "NAUTILUS-1", state: "Todo"}
    assert {:ok, %{state: "In Progress"}} = PlaneAdapter.claim_issue(issue)
    assert_receive {:plane_claim_called, ^issue}

    assert [%{"name" => "plane_api"}] = PlaneAdapter.agent_tool_specs()
    assert PlaneAdapter.secret_environment_names(settings) == ["PLANE_API_KEY"]

    assert {:ok, PlaneAdapter} = Tracker.adapter_for_kind("plane")

    assert PlaneAdapter.execute_agent_tool(
             "plane_api",
             %{"method" => "GET", "path" => "/api/v1/users/me/"},
             plane_client: fn _method, _path, _params, _body, _opts ->
               {:ok, %{status: 200, body: %{"id" => "user"}}}
             end
           )["success"]
  end

  test "plane_api preserves REST status and body while rejecting unsafe arguments" do
    tracker_settings = tracker_settings()

    response =
      PlaneAgentTool.execute(
        "plane_api",
        %{
          "method" => "post",
          "path" => " /api/v1/workspaces/plane/projects/ ",
          "params" => %{"per_page" => 10},
          "body" => %{"name" => "nautilus"}
        },
        tracker_settings: tracker_settings,
        plane_client: fn method, path, params, body, opts ->
          send(self(), {:plane_tool_called, method, path, params, body, opts})
          {:ok, %{status: 201, body: %{"id" => "project"}}}
        end
      )

    assert_received {:plane_tool_called, "POST", "/api/v1/workspaces/plane/projects/", %{"per_page" => 10}, %{"name" => "nautilus"}, [tracker_settings: ^tracker_settings]}

    assert response["success"] == true
    assert Jason.decode!(response["output"]) == %{"status" => 201, "body" => %{"id" => "project"}}
    assert response["contentItems"] == [%{"type" => "inputText", "text" => response["output"]}]

    assert PlaneAgentTool.execute("plane_api", %{"method" => "TRACE", "path" => "/api/v1/"}, [])["success"] == false
    assert PlaneAgentTool.execute("plane_api", %{"method" => 123, "path" => "/api/v1/"}, [])["success"] == false
    assert PlaneAgentTool.execute("plane_api", %{"method" => "GET", "path" => "https://plane.local/api"}, [])["success"] == false
    assert PlaneAgentTool.execute("plane_api", %{"method" => "GET", "path" => 123}, [])["success"] == false
    assert PlaneAgentTool.execute("plane_api", %{"method" => "GET", "path" => "/api/v1/", "params" => []}, [])["success"] == false
    assert PlaneAgentTool.execute("plane_api", "not-a-map", [])["success"] == false
    assert PlaneAgentTool.execute("plane_api", %{"method" => "GET"}, [])["success"] == false
    assert PlaneAgentTool.execute("unknown", %{}, [])["success"] == false

    assert PlaneAgentTool.execute(
             "plane_api",
             %{"method" => "GET", "path" => "/api/v1/users/me/"},
             plane_client: fn _method, _path, _params, _body, _opts -> {:error, :missing_plane_api_key} end
           )["success"] == false

    assert PlaneAgentTool.execute(
             "plane_api",
             %{"method" => "GET", "path" => "/api/v1/users/me/"},
             plane_client: fn _method, _path, _params, _body, _opts -> {:error, {:plane_api_request, :econnrefused}} end
           )["success"] == false

    assert PlaneAgentTool.execute(
             "plane_api",
             %{"method" => "GET", "path" => "/api/v1/users/me/"},
             plane_client: fn _method, _path, _params, _body, _opts -> {:error, :unexpected_reason} end
           )["success"] == false

    assert PlaneAgentTool.execute(
             "plane_api",
             %{"method" => "GET", "path" => "/api/v1/users/me/"},
             plane_client: fn _method, _path, _params, _body, _opts -> {:unexpected, :shape} end
           )["success"] == false

    inspect_response =
      PlaneAgentTool.execute(
        "plane_api",
        %{"method" => "GET", "path" => "/api/v1/users/me/"},
        plane_client: fn _method, _path, _params, _body, _opts -> {:ok, %{status: 200, body: %{pid: self()}}} end
      )

    assert inspect_response["success"] == true
    assert is_binary(inspect_response["output"])
  end

  test "tracker claim is a no-op for adapters without claim support" do
    write_workflow_file!(Workflow.workflow_file_path(), tracker_kind: "memory")
    issue = %Issue{id: "memory-1", identifier: "MEM-1", state: "Todo"}

    assert {:ok, ^issue} = Tracker.claim_issue(issue)
  end

  test "tracker claim delegates to adapters with claim support" do
    write_workflow_file!(Workflow.workflow_file_path(), tracker_kind: "plane")
    Application.put_env(:symphony_elixir, :plane_client_module, FakePlaneClient)

    issue = %Issue{id: "plane-1", identifier: "NAUTILUS-1", state: "Todo"}
    assert {:ok, %{state: "In Progress"}} = Tracker.claim_issue(issue)
    assert_receive {:plane_claim_called, ^issue}
  end

  test "client validates provider settings and declares token environments" do
    assert :ok = PlaneClient.validate_settings(tracker_settings())

    base_url_env_var = "SYMPHONY_PLANE_BASE_URL_#{System.unique_integer([:positive])}"
    previous_base_url = System.get_env(base_url_env_var)
    System.put_env(base_url_env_var, "http://plane.local")

    on_exit(fn -> restore_env(base_url_env_var, previous_base_url) end)

    assert {:ok, parsed_settings} =
             Schema.parse(%{
               tracker: %{
                 kind: "plane",
                 provider: %{
                   base_url: "$#{base_url_env_var}",
                   api_key: "plane-token",
                   workspace_slug: "plane",
                   project_identifier: "NAUTILUS"
                 }
               }
             })

    assert :ok = PlaneClient.validate_settings(parsed_settings.tracker)

    assert {:error, :missing_plane_base_url} =
             PlaneClient.validate_settings(tracker_settings(%{"base_url" => 123}))

    assert {:error, :invalid_plane_base_url} =
             PlaneClient.validate_settings(tracker_settings(%{"base_url" => "ftp://plane.local"}))

    assert {:error, :missing_plane_api_key} =
             PlaneClient.validate_settings(tracker_settings(%{"api_key" => 123}))

    assert {:error, :missing_plane_workspace_slug} =
             PlaneClient.validate_settings(tracker_settings(%{"workspace_slug" => " "}))

    assert {:error, :missing_plane_project_scope} =
             PlaneClient.validate_settings(tracker_settings(%{"project_id" => nil, "project_identifier" => nil}))

    assert {:error, :invalid_plane_project_id} =
             PlaneClient.validate_settings(tracker_settings(%{"project_id" => "not-a-uuid", "project_identifier" => nil}))

    assert PlaneClient.secret_environment_names(tracker_settings(%{"api_key" => "$SYMPHONY_PLANE_TOKEN"})) == [
             "PLANE_API_KEY",
             "SYMPHONY_PLANE_TOKEN"
           ]

    assert {:ok, []} =
             PlaneClient.fetch_issues_by_states_for_test(
               [],
               tracker_settings(),
               fn _method, _path, _params, _body, _settings ->
                 flunk("empty Plane state reads should not make an HTTP request")
               end
             )
  end

  test "client request sends Plane API headers query and JSON body" do
    tracker_settings = tracker_settings(%{"base_url" => " http://plane.local/ "})

    request_fun = fn method, path, params, body, settings ->
      send(self(), {:plane_request, method, path, params, body, settings})
      {:ok, %{status: 200, body: %{"ok" => true}}}
    end

    assert {:ok, %{status: 200, body: %{"ok" => true}}} =
             PlaneClient.request(
               "POST",
               "/api/v1/workspaces/plane/projects/",
               %{"per_page" => 50},
               %{"name" => "Nautilus"},
               tracker_settings: tracker_settings,
               request_fun: request_fun
             )

    assert_receive {:plane_request, "POST", "/api/v1/workspaces/plane/projects/", %{"per_page" => 50}, %{"name" => "Nautilus"},
                    %{
                      base_url: "http://plane.local",
                      api_key: "plane-token",
                      workspace_slug: "plane",
                      project_id: nil,
                      project_identifier: "NAUTILUS",
                      claim_state: "In Progress"
                    }}
  end

  test "client resolves project states, pages work item reads, and normalizes issues" do
    states_path = "/api/v1/workspaces/plane/projects/#{project_id()}/states/"
    work_items_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/"
    issue_1_comments_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(1)}/comments/"
    issue_1_relations_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(1)}/relations/"
    issue_2_comments_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(2)}/comments/"
    issue_2_relations_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(2)}/relations/"
    issue_2_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(2)}/"
    issue_3_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(3)}/"

    request_fun = fn method, path, params, body, settings ->
      send(self(), {:plane_call, method, path, params, body, settings})

      case {method, path, params} do
        {"GET", "/api/v1/workspaces/plane/projects/", _params} ->
          {:ok, %{status: 200, body: paged([raw_project()])}}

        {"GET", ^states_path, _params} ->
          {:ok, %{status: 200, body: paged([raw_state("Todo", todo_state_id()), raw_state("Done", done_state_id())])}}

        {"GET", ^work_items_path, %{"cursor" => "1000:1:1"}} ->
          {:ok, %{status: 200, body: paged([raw_issue(2, done_state_id())], false)}}

        {"GET", ^work_items_path, _params} ->
          {:ok, %{status: 200, body: paged([raw_issue(1, todo_state_id()), Map.put(raw_issue(3, todo_state_id()), "name", " ")], true)}}

        {"GET", ^issue_1_comments_path, _params} ->
          {:ok, %{status: 200, body: paged([raw_comment("comment-1", "Use the latest requirement")])}}

        {"GET", ^issue_1_relations_path, _params} ->
          {:ok, %{status: 200, body: %{"blocked_by" => [raw_relation_ref(issue_id(2)), raw_relation_ref(issue_id(3))]}}}

        {"GET", ^issue_2_path, %{}} ->
          {:ok, %{status: 200, body: raw_issue(2, todo_state_id())}}

        {"GET", ^issue_3_path, %{}} ->
          {:ok, %{status: 200, body: raw_issue(3, done_state_id())}}

        {"GET", ^issue_2_comments_path, _params} ->
          {:ok, %{status: 200, body: paged([raw_comment("comment-2", "Completed work")])}}

        {"GET", ^issue_2_relations_path, _params} ->
          {:ok, %{status: 200, body: %{"blocked_by" => []}}}
      end
    end

    log =
      capture_log(fn ->
        assert {:ok, [issue]} =
                 PlaneClient.fetch_issues_by_states_for_test(
                   [" todo "],
                   tracker_settings(),
                   request_fun
                 )

        assert issue.id == issue_id(1)
        assert issue.identifier == "NAUTILUS-1"

        assert issue.native_ref == %{
                 "id" => issue_id(1),
                 "project_id" => project_id(),
                 "project_identifier" => "NAUTILUS",
                 "sequence_id" => 1,
                 "workspace_slug" => "plane"
               }

        assert issue.title == "Work item 1"
        assert issue.description =~ "<p>Body 1</p>"
        assert issue.description =~ "Tracker comments:"
        assert issue.description =~ "Use the latest requirement"

        assert issue.comments == [
                 %{
                   "body" => "Use the latest requirement",
                   "created_at" => "2026-08-16T12:12:57.306499Z",
                   "id" => "comment-1"
                 }
               ]

        assert issue.blocked_by == [
                 %{
                   "id" => issue_id(2),
                   "identifier" => "NAUTILUS-2",
                   "project_id" => project_id(),
                   "state" => "Todo",
                   "title" => "Work item 2"
                 }
               ]

        assert issue.state == "Todo"
        assert issue.priority == 3
        assert issue.labels == ["bug", "platform"]
        assert issue.url == "http://plane.local/plane/browse/NAUTILUS-1"
        refute issue.dispatchable
        assert %DateTime{} = issue.created_at
        assert %DateTime{} = issue.updated_at
      end)

    assert log =~ "Dropping malformed Plane work item records count=1"

    assert_receive {:plane_call, "GET", "/api/v1/workspaces/plane/projects/", %{"per_page" => 100}, nil, _settings}
    assert_receive {:plane_call, "GET", ^states_path, %{"per_page" => 100}, nil, _settings}
    assert_receive {:plane_call, "GET", ^work_items_path, %{"per_page" => 100}, nil, _settings}
    assert_receive {:plane_call, "GET", ^work_items_path, %{"cursor" => "1000:1:1", "per_page" => 100}, nil, _settings}
    assert_receive {:plane_call, "GET", ^issue_1_comments_path, %{"per_page" => 100}, nil, _settings}
    assert_receive {:plane_call, "GET", ^issue_1_relations_path, %{}, nil, _settings}
    assert_receive {:plane_call, "GET", ^issue_2_path, %{}, nil, _settings}
    assert_receive {:plane_call, "GET", ^issue_3_path, %{}, nil, _settings}
    refute_receive {:plane_call, "GET", ^issue_2_comments_path, %{"per_page" => 100}, nil, _settings}
    refute_receive {:plane_call, "GET", ^issue_2_relations_path, %{}, nil, _settings}

    assert {:ok, [done_issue]} =
             PlaneClient.fetch_issues_by_states_for_test(
               ["Done"],
               tracker_settings(),
               request_fun
             )

    assert done_issue.state == "Done"
    assert [%{"body" => "Completed work"}] = done_issue.comments
    assert done_issue.blocked_by == []
    assert_receive {:plane_call, "GET", ^issue_2_comments_path, %{"per_page" => 100}, nil, _settings}
    assert_receive {:plane_call, "GET", ^issue_2_relations_path, %{}, nil, _settings}
    refute_receive {:plane_call, "GET", ^issue_1_comments_path, _, nil, _settings}
    refute_receive {:plane_call, "GET", ^issue_1_relations_path, %{}, nil, _settings}
  end

  test "client refreshes Plane UUIDs in order, omits 404s, and rejects malformed records" do
    issue_2_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(2)}/"
    issue_1_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(1)}/"
    issue_4_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(4)}/"
    issue_1_comments_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(1)}/comments/"
    issue_2_comments_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(2)}/comments/"
    issue_1_relations_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(1)}/relations/"
    issue_2_relations_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(2)}/relations/"
    states_path = "/api/v1/workspaces/plane/projects/#{project_id()}/states/"

    request_fun = fn "GET", path, params, nil, _settings ->
      send(self(), {:plane_id_path, path})

      case {path, params} do
        {^states_path, %{"per_page" => 100}} ->
          {:ok, %{status: 200, body: paged([raw_state("Todo", todo_state_id())])}}

        {^issue_2_path, %{}} ->
          {:ok, %{status: 200, body: raw_issue(2, todo_state_id())}}

        {^issue_1_path, %{}} ->
          {:ok, %{status: 200, body: raw_issue(1, todo_state_id())}}

        {^issue_4_path, %{}} ->
          {:ok, %{status: 404, body: %{"error" => "not found"}}}

        {^issue_1_comments_path, %{"per_page" => 100}} ->
          {:ok, %{status: 200, body: paged([raw_comment("comment-1", "Comment for 1")])}}

        {^issue_2_comments_path, %{"per_page" => 100}} ->
          {:ok, %{status: 200, body: paged([raw_comment("comment-2", "Comment for 2")])}}

        {^issue_1_relations_path, %{}} ->
          {:ok, %{status: 200, body: %{"blocked_by" => []}}}

        {^issue_2_relations_path, %{}} ->
          {:ok, %{status: 200, body: %{"blocked_by" => [raw_relation_ref(issue_id(1))]}}}
      end
    end

    settings = tracker_settings(%{"project_id" => project_id(), "project_identifier" => "NAUTILUS"})

    assert {:ok, issues} =
             PlaneClient.fetch_issues_by_ids_for_test(
               [issue_id(2), issue_id(1), issue_id(4), issue_id(2)],
               settings,
               request_fun
             )

    assert Enum.map(issues, & &1.id) == [issue_id(2), issue_id(1)]
    assert Enum.map(issues, &Enum.map(&1.blocked_by, fn blocker -> blocker["identifier"] end)) == [["NAUTILUS-1"], []]
    assert Enum.map(issues, &List.first(&1.comments)["body"]) == ["Comment for 2", "Comment for 1"]
    assert_receive {:plane_id_path, ^issue_2_path}
    assert_receive {:plane_id_path, ^issue_1_path}
    assert_receive {:plane_id_path, ^issue_4_path}
    assert_receive {:plane_id_path, ^issue_2_comments_path}
    assert_receive {:plane_id_path, ^issue_1_comments_path}
    assert_receive {:plane_id_path, ^issue_2_relations_path}
    assert_receive {:plane_id_path, ^issue_1_relations_path}
    refute_receive {:plane_id_path, ^issue_2_path}

    assert {:error, :invalid_plane_issue_id} =
             PlaneClient.fetch_issues_by_ids_for_test(["not-a-uuid"], settings, request_fun)

    assert {:error, :plane_unknown_payload} =
             PlaneClient.fetch_issues_by_ids_for_test(
               [issue_id(3)],
               settings,
               fn "GET", path, params, nil, _settings ->
                 case {path, params} do
                   {^states_path, %{"per_page" => 100}} ->
                     {:ok, %{status: 200, body: paged([raw_state("Todo", todo_state_id())])}}

                   {_path, %{}} ->
                     {:ok, %{status: 200, body: Map.put(raw_issue(3, todo_state_id()), "name", "")}}
                 end
               end
             )
  end

  test "client combines active Plane subtask and relation blockers" do
    states_path = "/api/v1/workspaces/plane/projects/#{project_id()}/states/"
    work_items_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/"
    parent_comments_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(1)}/comments/"
    active_child_comments_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(2)}/comments/"
    done_child_comments_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(3)}/comments/"
    parent_relations_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(1)}/relations/"
    active_child_relations_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(2)}/relations/"
    done_child_relations_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(3)}/relations/"
    active_child_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(2)}/"
    relation_blocker_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(4)}/"
    in_progress_state_id = "7c4f771b-95e0-44df-ac1b-52c0456ac4a3"

    request_fun = fn method, path, params, body, _settings ->
      send(self(), {:plane_subtask_call, method, path, params, body})

      case {method, path, params, body} do
        {"GET", "/api/v1/workspaces/plane/projects/", %{"per_page" => 100}, nil} ->
          {:ok, %{status: 200, body: paged([raw_project()])}}

        {"GET", ^states_path, %{"per_page" => 100}, nil} ->
          {:ok,
           %{
             status: 200,
             body: paged([raw_state("Todo", todo_state_id()), raw_state("In Progress", in_progress_state_id), raw_state("Done", done_state_id())])
           }}

        {"GET", ^work_items_path, %{"per_page" => 100}, nil} ->
          {:ok,
           %{
             status: 200,
             body:
               paged([
                 raw_issue(1, todo_state_id()),
                 Map.put(raw_issue(2, in_progress_state_id), "parent", issue_id(1)),
                 Map.put(raw_issue(3, done_state_id()), "parent", issue_id(1))
               ])
           }}

        {"GET", path, %{"per_page" => 100}, nil} when path in [parent_comments_path, active_child_comments_path, done_child_comments_path] ->
          {:ok, %{status: 200, body: paged([])}}

        {"GET", ^parent_relations_path, %{}, nil} ->
          {:ok,
           %{
             status: 200,
             body: %{"blocked_by" => [raw_relation_ref(issue_id(2)), raw_relation_ref(issue_id(4))]}
           }}

        {"GET", ^active_child_path, %{}, nil} ->
          {:ok, %{status: 404, body: %{"error" => "not found"}}}

        {"GET", ^relation_blocker_path, %{}, nil} ->
          {:ok, %{status: 200, body: raw_issue(4, in_progress_state_id)}}

        {"GET", path, %{}, nil} when path in [active_child_relations_path, done_child_relations_path] ->
          {:ok, %{status: 200, body: %{"blocked_by" => []}}}
      end
    end

    assert {:ok, [parent]} =
             PlaneClient.fetch_issues_by_states_for_test(
               ["Todo"],
               tracker_settings(),
               request_fun
             )

    assert parent.identifier == "NAUTILUS-1"

    assert parent.blocked_by == [
             %{
               "id" => issue_id(2),
               "identifier" => "NAUTILUS-2",
               "project_id" => project_id(),
               "state" => "In Progress",
               "title" => "Work item 2"
             },
             %{
               "id" => issue_id(4),
               "identifier" => "NAUTILUS-4",
               "project_id" => project_id(),
               "state" => "In Progress",
               "title" => "Work item 4"
             }
           ]

    refute parent.dispatchable
    assert_receive {:plane_subtask_call, "GET", ^active_child_path, %{}, nil}
    refute_receive {:plane_subtask_call, "GET", ^active_child_comments_path, _, _}
    refute_receive {:plane_subtask_call, "GET", ^done_child_comments_path, _, _}
    refute_receive {:plane_subtask_call, "GET", ^active_child_relations_path, _, _}
    refute_receive {:plane_subtask_call, "GET", ^done_child_relations_path, _, _}
  end

  test "client claims a Plane issue by patching configured claim state" do
    issue = %SymphonyElixir.Tracker.Issue{id: issue_id(1), identifier: "NAUTILUS-1", state: "Todo"}
    settings = tracker_settings(%{"project_id" => project_id(), "project_identifier" => "NAUTILUS"})
    states_path = "/api/v1/workspaces/plane/projects/#{project_id()}/states/"
    issue_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(1)}/"
    issue_comments_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(1)}/comments/"
    issue_relations_path = "/api/v1/workspaces/plane/projects/#{project_id()}/work-items/#{issue_id(1)}/relations/"
    in_progress_state_id = "7c4f771b-95e0-44df-ac1b-52c0456ac4a3"

    request_fun = fn method, path, params, body, _settings ->
      send(self(), {:plane_claim_call, method, path, params, body})

      case {method, path, params, body} do
        {"GET", ^states_path, %{"per_page" => 100}, nil} ->
          {:ok, %{status: 200, body: paged([raw_state("Todo", todo_state_id()), raw_state("In Progress", in_progress_state_id)])}}

        {"PATCH", ^issue_path, %{}, %{"state" => ^in_progress_state_id}} ->
          {:ok, %{status: 200, body: Map.put(raw_issue(1, in_progress_state_id), "name", "Claimed item")}}

        {"GET", ^issue_comments_path, %{"per_page" => 100}, nil} ->
          {:ok, %{status: 200, body: paged([])}}

        {"GET", ^issue_relations_path, %{}, nil} ->
          {:ok, %{status: 200, body: %{"blocked_by" => []}}}
      end
    end

    assert {:ok, claimed_issue} = PlaneClient.claim_issue_for_test(issue, settings, request_fun)
    assert claimed_issue.id == issue_id(1)
    assert claimed_issue.title == "Claimed item"
    assert claimed_issue.state == "In Progress"

    assert_receive {:plane_claim_call, "GET", ^states_path, %{"per_page" => 100}, nil}
    assert_receive {:plane_claim_call, "PATCH", ^issue_path, %{}, %{"state" => ^in_progress_state_id}}
  end

  defp tracker_settings(provider_overrides \\ %{}) do
    %{
      api_key: Map.get(provider_overrides, "api_key", "plane-token"),
      provider:
        Map.merge(
          %{
            "base_url" => "http://plane.local",
            "api_key" => Map.get(provider_overrides, "api_key", "plane-token"),
            "workspace_slug" => "plane",
            "project_identifier" => "NAUTILUS",
            "claim_state" => "In Progress"
          },
          provider_overrides
        ),
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Cancelled", "Canceled"]
    }
  end

  defp project_id, do: "15fc5a63-cafa-41a2-b29b-aab5e1870e0a"
  defp todo_state_id, do: "241f3358-1734-4dbc-96a5-b667276d5e4e"
  defp done_state_id, do: "95547efd-6a9c-4705-8a08-51517db4844b"
  defp issue_id(number), do: "00000000-0000-0000-0000-00000000000#{number}"

  defp paged(results, has_next \\ false) do
    %{
      "results" => results,
      "next_page_results" => has_next,
      "next_cursor" => if(has_next, do: "1000:1:1", else: "1000:1:0")
    }
  end

  defp raw_project do
    %{"id" => project_id(), "identifier" => "NAUTILUS", "name" => "nautilus"}
  end

  defp raw_state(name, id) do
    %{"id" => id, "name" => name, "group" => String.downcase(name)}
  end

  defp raw_issue(sequence_id, state_id) do
    %{
      "id" => issue_id(sequence_id),
      "sequence_id" => sequence_id,
      "name" => "Work item #{sequence_id}",
      "description_html" => "<p>Body #{sequence_id}</p>",
      "priority" => "medium",
      "state" => state_id,
      "labels" => [%{"name" => "Bug"}, %{"name" => " platform "}],
      "assignees" => [%{"id" => "user-1"}],
      "created_at" => "2026-08-10T20:06:44.992812Z",
      "updated_at" => "2026-08-10T20:06:44.992852Z"
    }
  end

  defp raw_comment(id, body) do
    %{
      "id" => id,
      "comment_html" => body,
      "created_at" => "2026-08-16T12:12:57.306499Z"
    }
  end

  defp raw_relation_ref(issue_id) do
    %{"project_id" => project_id(), "issue_id" => issue_id}
  end
end
