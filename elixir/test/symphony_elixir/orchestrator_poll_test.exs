defmodule SymphonyElixir.OrchestratorPollTest do
  use SymphonyElixir.TestSupport

  setup do
    defaults = Req.default_options()
    owner = self()

    Req.default_options(
      retry: false,
      plug: fn conn ->
        send(owner, {:tracker_request, self()})

        receive do
          {:respond, status, nodes} ->
            body = %{"data" => %{"issues" => %{"nodes" => nodes, "pageInfo" => %{"hasNextPage" => false}}}}

            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(status, Jason.encode!(body))
        end
      end
    )

    on_exit(fn -> Req.default_options(defaults) end)
    write_workflow_file!(Workflow.workflow_file_path(), tracker_kind: "memory", poll_interval_ms: 60_000)
    pid = start_supervised!(Supervisor.child_spec({Orchestrator, name: __MODULE__.Server}, restart: :temporary))

    wait_until(fn ->
      state = :sys.get_state(pid)

      state.tracker_task == nil and state.startup_cleanup_task == nil and is_integer(state.next_poll_due_at_ms) and
        state.next_poll_due_at_ms > System.monotonic_time(:millisecond) + 30_000
    end)

    :sys.replace_state(pid, fn state ->
      if state.tick_timer_ref, do: Process.cancel_timer(state.tick_timer_ref)
      %{state | tick_timer_ref: nil, tick_token: nil}
    end)

    write_workflow_file!(Workflow.workflow_file_path(), poll_interval_ms: 60_000)
    %{pid: pid}
  end

  test "blocked tracker HTTP leaves snapshots responsive", %{pid: pid} do
    send(pid, :run_poll_cycle)
    assert_receive {:tracker_request, request}, 1_000

    try do
      assert %{polling: %{checking?: true}} = Orchestrator.snapshot(__MODULE__.Server, 100)
    after
      send(request, {:respond, 200, []})
    end
  end

  test "repeated ticks and refreshes share one blocked request", %{pid: pid} do
    request = begin_poll(pid)
    task = :sys.get_state(pid).tracker_task

    for _ <- 1..5 do
      send(pid, :tick)
      send(pid, :run_poll_cycle)
      assert %{coalesced: true} = GenServer.call(pid, :request_refresh, 100)
    end

    assert :sys.get_state(pid).tracker_task.ref == task.ref
    refute_receive {:tracker_request, _}, 50
    respond(request)
    await_idle(pid)
    assert %{polling: %{checking?: false, next_poll_in_ms: ms}} = snapshot()
    assert is_integer(ms)
  end

  test "worker updates and exact correction owner survive blocked reconciliation", %{pid: pid} do
    worker = put_worker(pid)
    request = begin_poll(pid)
    now = DateTime.utc_now()

    send(pid, {:worker_runtime_info, "issue-1", %{workspace_path: "/tmp/poll-owner", codex_app_server_pid: "42"}})

    send(
      pid,
      {:codex_worker_update, "issue-1",
       %{
         event: :session_started,
         timestamp: now,
         session_id: "session-new",
         codex_app_server_pid: "42",
         correction_delivery_supported: true
       }}
    )

    send(
      pid,
      {:codex_worker_update, "issue-1",
       %{
         event: :notification,
         timestamp: now,
         payload: %{"params" => %{"tokenUsage" => %{"total" => %{"inputTokens" => 12, "outputTokens" => 4, "totalTokens" => 16}}}}
       }}
    )

    send(pid, {:worker_runtime_info, "issue-1", %{workspace_path: "/tmp/stale-owner", codex_app_server_pid: "old", source_revision: "new-revision"}})

    assert %{running: [%{session_id: "session-new", codex_total_tokens: 16}]} = snapshot()

    correction = %{
      instruction_id: "correction-1",
      issue_id: "issue-1",
      issue_identifier: "POLL-1",
      session_id: "session-new",
      workspace_path: "/tmp/poll-owner",
      worker_pid: "42",
      worker_host: nil,
      text: "Preserve this correction."
    }

    assert {:ok, %{status: :queued}} = GenServer.call(pid, {:queue_correction, correction}, 100)
    assert_receive {:worker_message, ^worker, {:deliver_correction, ^correction}}

    respond(request, [issue_node("In Progress")])
    assert_receive {:tracker_request, candidates}, 1_000
    respond(candidates)
    await_idle(pid)
    state = :sys.get_state(pid)
    assert state.running["issue-1"].source_revision == "new-revision"
    assert state.running["issue-1"].workspace_path == "/tmp/poll-owner"
    assert state.running["issue-1"].codex_app_server_pid == "42"
    assert state.running["issue-1"].session_id == "session-new"
    assert state.codex_totals.total_tokens == 16
    assert state.corrections["correction-1"].status == :queued
  end

  test "worker exit during HTTP preserves its new retry claim", %{pid: pid} do
    worker = put_worker(pid)
    request = begin_poll(pid)
    Process.exit(worker, :kill)
    wait_until(fn -> Map.has_key?(:sys.get_state(pid).retry_attempts, "issue-1") end)
    retry = :sys.get_state(pid).retry_attempts["issue-1"]

    respond(request, [issue_node("Done")])
    assert_receive {:tracker_request, candidates}, 1_000
    respond(candidates)
    await_idle(pid)
    state = :sys.get_state(pid)
    assert state.running == %{}
    assert state.retry_attempts["issue-1"] == retry
    assert MapSet.member?(state.claimed, "issue-1")
  end

  test "missing response for old worker cannot remove replacement owner", %{pid: pid} do
    put_worker(pid)
    request = begin_poll(pid)
    replacement = put_worker(pid)
    respond(request)
    assert_receive {:tracker_request, candidates}, 1_000
    respond(candidates)
    await_idle(pid)
    assert :sys.get_state(pid).running["issue-1"].pid == replacement
    assert Process.alive?(replacement)
  end

  test "failed HTTP and killed poll recover and allow subsequent polls", %{pid: pid} do
    for failure <- [:http, :crash] do
      request = begin_poll(pid)
      assert is_map(snapshot())

      case failure do
        :http -> send(request, {:respond, 503, []})
        :crash -> Process.exit(:sys.get_state(pid).tracker_task.pid, :kill)
      end

      await_idle(pid)
      assert Process.alive?(pid)
      assert %{polling: %{checking?: false, next_poll_in_ms: ms}} = snapshot()
      assert is_integer(ms)
    end

    respond(begin_poll(pid))
    await_idle(pid)
  end

  test "stopping orchestrator terminates blocked tracker task", %{pid: pid} do
    begin_poll(pid)
    task = :sys.get_state(pid).tracker_task
    monitor = Process.monitor(task.pid)
    GenServer.stop(pid)
    assert_receive {:DOWN, ^monitor, :process, _, _}, 1_000
  end

  test "terminal reconciliation cleans the current recorded workspace", %{pid: pid} do
    worker = put_worker(pid)
    root = Path.join(System.tmp_dir!(), "poll-cleanup-#{System.unique_integer([:positive])}")
    workspace = Path.join(root, "POLL-1")
    File.mkdir_p!(workspace)
    on_exit(fn -> File.rm_rf(root) end)
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: root, poll_interval_ms: 60_000)
    send(pid, {:worker_runtime_info, "issue-1", %{workspace_path: workspace, workspace_managed: true}})
    request = begin_poll(pid)
    respond(request, [issue_node("Done")])
    assert_receive {:tracker_request, candidates}, 1_000
    respond(candidates)
    await_idle(pid)
    refute Process.alive?(worker)
    refute File.exists?(workspace)
    refute MapSet.member?(:sys.get_state(pid).claimed, "issue-1")
  end

  test "retry HTTP is single flight and stale retry responses are ignored", %{pid: pid} do
    token = put_retry(pid)
    request = begin_poll(pid)
    send(pid, {:retry_issue, "issue-1", token})
    assert is_map(snapshot())
    refute_receive {:tracker_request, _}, 50
    respond(request)
    assert_receive {:tracker_request, retry_request}, 1_000
    assert is_map(snapshot())
    replacement = put_retry(pid)
    respond(retry_request, [issue_node("Done")])
    await_idle(pid)
    assert :sys.get_state(pid).retry_attempts["issue-1"].retry_token == replacement
    assert MapSet.member?(:sys.get_state(pid).claimed, "issue-1")
  end

  test "failed retry increments backoff and releases the flight", %{pid: pid} do
    token = put_retry(pid)
    send(pid, {:retry_issue, "issue-1", token})
    assert_receive {:tracker_request, request}, 1_000
    send(request, {:respond, 503, []})
    await_idle(pid)
    retry = :sys.get_state(pid).retry_attempts["issue-1"]
    assert retry.attempt == 3
    assert retry.retry_token != token
    assert retry.error =~ "retry poll failed"
  end

  test "reload discards response from previous tracker configuration", %{pid: pid} do
    request = begin_poll(pid)
    write_workflow_file!(Workflow.workflow_file_path(), tracker_kind: "memory", poll_interval_ms: 60_000)
    respond(request, [issue_node("Todo")])
    await_idle(pid)
    assert :sys.get_state(pid).running == %{}
    refute_receive {:tracker_request, _}, 50
  end

  test "invalid tracker config finishes poll without HTTP", %{pid: pid} do
    write_workflow_file!(Workflow.workflow_file_path(), tracker_api_token: nil, poll_interval_ms: 60_000)
    send(pid, :run_poll_cycle)
    await_idle(pid)
    assert is_map(snapshot())
    refute_receive {:tracker_request, _}, 50
  end

  test "dispatch revalidation stays responsive and rechecks current ownership", %{pid: pid} do
    request = begin_poll(pid)
    respond(request, [issue_node("Todo")])
    assert_receive {:tracker_request, refresh}, 1_000
    assert is_map(snapshot())
    worker = put_worker(pid)
    respond(refresh, [issue_node("Todo")])
    await_idle(pid)
    assert :sys.get_state(pid).running["issue-1"].pid == worker
    refute_receive {:tracker_request, _}, 50
  end

  test "retry traffic preserves the existing periodic poll deadline", %{pid: pid} do
    due_at = System.monotonic_time(:millisecond) + 300

    :sys.replace_state(pid, fn state ->
      token = make_ref()
      timer = Process.send_after(self(), {:tick, token}, 300)
      %{state | tick_token: token, tick_timer_ref: timer, next_poll_due_at_ms: due_at}
    end)

    for _ <- 1..3 do
      token = put_retry(pid)
      send(pid, {:retry_issue, "issue-1", token})
      assert_receive {:tracker_request, request}, 1_000
      send(request, {:respond, 503, []})
      await_idle(pid)
      assert :sys.get_state(pid).next_poll_due_at_ms <= due_at + 10
    end

    assert_receive {:tracker_request, periodic_poll}, 1_000
    respond(periodic_poll)
    await_idle(pid)
  end

  test "active dispatch does not wait for startup terminal HTTP and late cleanup protects its workspace", %{pid: pid} do
    GenServer.stop(pid)
    root = Path.join(System.tmp_dir!(), "poll-startup-#{System.unique_integer([:positive])}")
    old_workspace = Path.join(root, "POLL-2")
    File.mkdir_p!(old_workspace)
    on_exit(fn -> File.rm_rf(root) end)
    write_workflow_file!(Workflow.workflow_file_path(), workspace_root: root, poll_interval_ms: 60_000, hook_before_run: "sleep 5")
    tasks = start_supervised!({Task.Supervisor, []})

    pid =
      start_supervised!(
        Supervisor.child_spec(
          {Orchestrator, name: __MODULE__.Server, task_supervisor: tasks},
          id: :startup_dispatch,
          restart: :temporary
        )
      )

    assert_receive {:tracker_request, terminal}, 1_000
    # This must arrive BEFORE allowing the startup terminal fetch to return.
    assert_receive {:tracker_request, candidates}, 1_000
    respond(candidates, [issue_node("Todo")])
    assert_receive {:tracker_request, refresh}, 1_000
    respond(refresh, [issue_node("Todo")])
    wait_until(fn -> Map.has_key?(:sys.get_state(pid).running, "issue-1") end)
    await_idle(pid)
    worker = :sys.get_state(pid).running["issue-1"].pid
    workspace = Path.join(root, "POLL-1")
    wait_until(fn -> File.dir?(workspace) end)
    assert Process.alive?(worker)
    tick = :sys.get_state(pid).tick_token
    old_issue = Map.merge(issue_node("Done"), %{"id" => "issue-2", "identifier" => "POLL-2"})
    respond(terminal, [issue_node("Done"), old_issue])
    wait_until(fn -> not File.exists?(old_workspace) end)
    assert File.dir?(workspace)
    assert Process.alive?(worker)
    assert :sys.get_state(pid).tick_token == tick
    refute_receive {:tracker_request, _}, 50
  end

  test "startup terminal fetch is nonblocking and failure still schedules polling", %{pid: pid} do
    GenServer.stop(pid)
    pid = start_supervised!(Supervisor.child_spec({Orchestrator, name: __MODULE__.Server}, id: :startup))
    assert_receive {:tracker_request, startup}, 1_000
    assert is_map(snapshot())
    send(startup, {:respond, 503, []})
    assert_receive {:tracker_request, poll}, 1_000
    respond(poll)
    await_idle(pid)
  end

  test "failed running refresh retains the current worker", %{pid: pid} do
    worker = put_worker(pid)
    request = begin_poll(pid)
    send(pid, {:worker_runtime_info, "issue-1", %{source_revision: "during-failure"}})
    assert is_map(snapshot())
    send(request, {:respond, 503, []})
    assert_receive {:tracker_request, candidates}, 1_000
    respond(candidates)
    await_idle(pid)
    assert :sys.get_state(pid).running["issue-1"].pid == worker
    assert :sys.get_state(pid).running["issue-1"].source_revision == "during-failure"
  end

  test "retry dispatch refresh cannot consume a newer retry token", %{pid: pid} do
    token = put_retry(pid)
    send(pid, {:retry_issue, "issue-1", token})
    assert_receive {:tracker_request, lookup}, 1_000
    respond(lookup, [issue_node("In Progress")])
    assert_receive {:tracker_request, refresh}, 1_000
    assert is_map(snapshot())
    replacement = put_retry(pid)
    respond(refresh, [issue_node("In Progress")])
    await_idle(pid)
    assert :sys.get_state(pid).running == %{}
    assert :sys.get_state(pid).retry_attempts["issue-1"].retry_token == replacement
  end

  test "brutal owner exit also kills its blocked tracker task", %{pid: pid} do
    begin_poll(pid)
    task = :sys.get_state(pid).tracker_task
    monitor = Process.monitor(task.pid)
    Process.exit(pid, :kill)
    assert_receive {:DOWN, ^monitor, :process, _, _}, 1_000
  end

  test "failed startup cleanup does not consume or reschedule the active poll", %{pid: pid} do
    GenServer.stop(pid)

    pid =
      start_supervised!(
        Supervisor.child_spec(
          {Orchestrator, name: __MODULE__.Server},
          id: :startup_failure,
          restart: :temporary
        )
      )

    assert_receive {:tracker_request, _terminal}, 1_000
    assert_receive {:tracker_request, active}, 1_000
    before = :sys.get_state(pid)
    Process.exit(before.startup_cleanup_task.pid, :kill)
    wait_until(fn -> :sys.get_state(pid).startup_cleanup_task == nil end)
    after_failure = :sys.get_state(pid)
    assert after_failure.tracker_task.ref == before.tracker_task.ref
    assert after_failure.poll_check_in_progress == before.poll_check_in_progress
    assert after_failure.tick_token == before.tick_token
    assert after_failure.pending_retries == before.pending_retries
    respond(active)
    await_idle(pid)
  end

  test "normal and abrupt owner death terminate both startup and active fetches", %{pid: pid} do
    GenServer.stop(pid)

    for reason <- [:normal, :kill] do
      pid =
        start_supervised!(
          Supervisor.child_spec(
            {Orchestrator, name: __MODULE__.Server},
            id: make_ref(),
            restart: :temporary
          )
        )

      assert_receive {:tracker_request, _terminal}, 1_000
      assert_receive {:tracker_request, _active}, 1_000
      state = :sys.get_state(pid)
      monitors = Enum.map([state.startup_cleanup_task, state.tracker_task], &Process.monitor(&1.pid))
      if reason == :normal, do: GenServer.stop(pid), else: Process.exit(pid, :kill)

      for monitor <- monitors do
        assert_receive {:DOWN, ^monitor, :process, _, _}, 1_000
      end
    end
  end

  defp begin_poll(pid) do
    send(pid, :run_poll_cycle)
    assert_receive {:tracker_request, request}, 1_000
    request
  end

  defp respond(request, nodes \\ []), do: send(request, {:respond, 200, nodes})
  defp snapshot, do: Orchestrator.snapshot(__MODULE__.Server, 100)

  defp await_idle(pid) do
    wait_until(fn ->
      state = :sys.get_state(pid)
      state.tracker_task == nil and state.poll_check_in_progress == false
    end)
  end

  defp wait_until(fun, attempts \\ 200)
  defp wait_until(fun, 0), do: assert(fun.())

  defp wait_until(fun, attempts) do
    if not fun.() do
      Process.sleep(5)
      wait_until(fun, attempts - 1)
    end
  end

  defp issue_node(state) do
    %{
      "id" => "issue-1",
      "identifier" => "POLL-1",
      "title" => "Poll fixture",
      "state" => %{"name" => state},
      "url" => "https://example.test/POLL-1",
      "labels" => %{"nodes" => []},
      "relations" => %{"nodes" => []}
    }
  end

  defp put_worker(pid) do
    owner = self()
    worker = start_supervised!(Supervisor.child_spec({Task, fn -> worker_loop(owner) end}, id: make_ref()))

    :sys.replace_state(pid, fn state ->
      issue = %Issue{id: "issue-1", identifier: "POLL-1", title: "Poll fixture", state: "In Progress", dispatchable: true}

      entry = %{
        pid: worker,
        ref: Process.monitor(worker),
        issue: issue,
        identifier: issue.identifier,
        started_at: DateTime.utc_now(),
        session_id: nil,
        codex_app_server_pid: nil,
        worker_host: nil,
        last_codex_timestamp: nil,
        last_codex_message: nil,
        last_codex_event: nil,
        codex_input_tokens: 0,
        codex_output_tokens: 0,
        codex_total_tokens: 0
      }

      %{state | running: Map.put(state.running, issue.id, entry), claimed: MapSet.put(state.claimed, issue.id)}
    end)

    worker
  end

  defp worker_loop(owner) do
    receive do
      message ->
        send(owner, {:worker_message, self(), message})
        worker_loop(owner)
    end
  end

  defp put_retry(pid) do
    token = make_ref()

    :sys.replace_state(pid, fn state ->
      due_at_ms = System.monotonic_time(:millisecond) + 60_000
      retry = %{retry_token: token, timer_ref: nil, attempt: 2, identifier: "POLL-1", due_at_ms: due_at_ms}
      retries = Map.put(state.retry_attempts, "issue-1", retry)
      %{state | retry_attempts: retries, claimed: MapSet.put(state.claimed, "issue-1")}
    end)

    token
  end
end
