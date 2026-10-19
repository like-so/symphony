defmodule SymphonyElixir.Codex.ProviderWaitTest do
  use ExUnit.Case, async: true
  alias SymphonyElixir.Codex.ProviderWait

  @now ~U[2026-10-11 14:00:00Z]
  @epoch DateTime.to_unix(@now, :millisecond)

  defp start(id, deadline, timeout \\ 1_800_000) do
    %{
      timestamp: @now,
      payload: %{
        "method" => "turn/providerFirstWait",
        "params" => %{
          "phase" => "started",
          "trace_id" => id,
          "deadline_unix_ms" => deadline,
          "timeout_ms" => timeout
        }
      }
    }
  end

  defp stop(id) do
    %{timestamp: @now, payload: %{"method" => "turn/providerFirstWait", "params" => %{"phase" => "ended", "trace_id" => id}}}
  end

  test "expires at the actual deadline without extending it on duplicates" do
    state = ProviderWait.update(nil, start("a", @epoch + 1000))
    assert ProviderWait.pending?(state, @now)
    refute ProviderWait.pending?(state, DateTime.add(@now, 1000, :millisecond))
    assert ProviderWait.update(state, start("a", @epoch + 2000)) == state
  end

  test "first response closes only its matching wait and replay cannot reopen it" do
    state = ProviderWait.update(nil, start("a", @epoch + 1000))
    assert ProviderWait.update(state, stop("older")) == state
    closed = ProviderWait.update(state, stop("a"))
    refute ProviderWait.pending?(closed, @now)
    assert ProviderWait.update(closed, start("a", @epoch + 2000)) == closed
    assert ProviderWait.pending?(ProviderWait.update(closed, start("b", @epoch + 2000)), @now)
  end

  test "starting a wait is metadata, not progress; its first response is activity" do
    previous = DateTime.add(@now, -1000, :second)
    beginning = start("a", @epoch + 1000)
    assert ProviderWait.activity_timestamp(nil, beginning, previous, @now) == previous
    state = ProviderWait.update(nil, beginning)
    assert ProviderWait.activity_timestamp(state, stop("a"), previous, @now) == @now
    assert ProviderWait.activity_timestamp(state, stop("older"), previous, @now) == previous
    closed = ProviderWait.update(state, stop("a"))
    assert ProviderWait.activity_timestamp(closed, stop("a"), previous, @now) == previous
  end

  test "rejects deadlines beyond the declared budget and malformed timeouts" do
    assert ProviderWait.update(nil, start("a", @epoch + 1002, 1000)) == nil
    assert ProviderWait.update(nil, start("a", @epoch + 1000, false)) == nil
    assert ProviderWait.update(nil, start("", @epoch + 1000)) == nil
    assert ProviderWait.update(nil, start("a", @epoch + 1001, 1000)) != nil
  end

  test "terminal turns clear wait state and ordinary activity stays unchanged" do
    state = ProviderWait.update(nil, start("a", @epoch + 1000))

    for event <- [:turn_completed, :turn_failed, :turn_cancelled] do
      assert ProviderWait.update(state, %{event: event}) == nil
    end

    assert ProviderWait.update(state, %{event: :notification}) == state
    assert ProviderWait.activity_timestamp(state, %{event: :notification}, nil, @now) == @now
    refute ProviderWait.pending?(nil, @now)
  end
end

defmodule SymphonyElixir.Codex.ProviderWaitIntegrationTest do
  use SymphonyElixir.TestSupport
  alias SymphonyElixir.Codex.ProviderWait

  for outcome <- [:response, :expiry] do
    @tag outcome: outcome
    test "AppServer notifications protect an idle worker until #{outcome}", %{outcome: outcome} do
      root = Path.join(System.tmp_dir!(), "provider-wait-otp-#{System.unique_integer([:positive])}")
      workspace = Path.join(root, "workspaces/WAIT-1")
      executable = Path.join(root, "peer")
      File.mkdir_p!(workspace)
      deadline = DateTime.to_unix(DateTime.utc_now(), :millisecond) + 60_000

      File.write!(executable, """
      #!/bin/sh
      count=0
      while IFS= read -r line; do
        count=$((count + 1))
        case "$count" in
          1) printf '%s\\n' '{"id":1,"result":{}}' ;;
          2) ;;
          3) printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-wait"}}}' ;;
          4)
            printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-wait"}}}'
            IFS= read -r line || exit 0
            printf '%s\\n' '{"method":"turn/providerFirstWait","params":{"turnId":"old-turn","phase":"started","trace_id":"stale-wait","timeout_ms":60000,"deadline_unix_ms":#{deadline}}}'
            printf '%s\\n' '{"method":"turn/providerFirstWait","params":{"turnId":"turn-wait","phase":"started","trace_id":"request-wait","timeout_ms":60000,"deadline_unix_ms":#{deadline}}}'
            IFS= read -r line || exit 0
            printf '%s\\n' '{"method":"turn/providerFirstWait","params":{"turnId":"turn-wait","phase":"ended","trace_id":"request-wait"}}'
            printf '%s\\n' '{"method":"turn/completed"}'
            exit 0 ;;
        esac
      done
      """)

      File.chmod!(executable, 0o755)

      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "memory",
        workspace_root: Path.join(root, "workspaces"),
        codex_command: executable,
        codex_stall_timeout_ms: 1_000,
        observability_enabled: false
      )

      Application.put_env(:symphony_elixir, :memory_tracker_issues, [])
      {:ok, controller} = Orchestrator.start_link(name: __MODULE__)
      parent = self()
      issue = %Issue{id: "wait-issue", identifier: "WAIT-1", title: "Wait fixture", state: "In Progress", dispatchable: true}

      task =
        Task.Supervisor.async_nolink(SymphonyElixir.TaskSupervisor, fn ->
          {:ok, session} = AppServer.start_session(workspace)
          send(parent, {:session, session})

          receive do
            :run -> :ok
          end

          try do
            AppServer.run_turn(session, "fixture", issue,
              on_message: fn update ->
                send(controller, {:codex_worker_update, issue.id, update})
                send(parent, {:update, update})
              end
            )
          after
            AppServer.stop_session(session)
          end
        end)

      try do
        assert_receive {:session, session}, 5_000
        stale = DateTime.add(DateTime.utc_now(), -5, :second)

        entry = %{
          pid: task.pid,
          ref: task.ref,
          identifier: issue.identifier,
          issue: issue,
          session_id: nil,
          turn_count: 0,
          last_codex_message: nil,
          last_codex_timestamp: stale,
          last_codex_event: nil,
          started_at: stale
        }

        await_idle(controller)

        :sys.replace_state(controller, fn state ->
          %{state | running: %{issue.id => entry}, claimed: MapSet.new([issue.id])}
        end)

        Application.put_env(:symphony_elixir, :memory_tracker_issues, [issue])
        send(task.pid, :run)
        assert_receive {:update, %{event: :session_started}}, 5_000
        :sys.replace_state(controller, &put_in(&1.running[issue.id].last_codex_timestamp, stale))
        Port.command(session.port, "start\n")
        assert_receive {:update, %{payload: %{"method" => "turn/providerFirstWait", "params" => %{"trace_id" => "request-wait", "phase" => "started"}}}}, 5_000
        refute_receive {:update, %{payload: %{"method" => "turn/providerFirstWait", "params" => %{"trace_id" => "stale-wait"}}}}, 0
        state = :sys.get_state(controller)
        assert state.running[issue.id].last_codex_timestamp == stale
        assert state.running[issue.id].provider_first_wait.deadline_ms == deadline
        send(controller, :run_poll_cycle)
        state = await_idle(controller)
        assert Process.alive?(task.pid)
        assert state.running[issue.id].last_codex_timestamp == stale

        if outcome == :response do
          Port.command(session.port, "release\n")
          assert_receive {:update, %{payload: %{"method" => "turn/providerFirstWait", "params" => %{"phase" => "ended"}}}}, 5_000
          assert {:ok, _} = Task.await(task, 5_000)
          state = :sys.get_state(controller)
          assert DateTime.compare(state.running[issue.id].last_codex_timestamp, stale) == :gt
          refute ProviderWait.pending?(state.running[issue.id].provider_first_wait, DateTime.utc_now())
        else
          :sys.replace_state(controller, &put_in(&1.running[issue.id].provider_first_wait.deadline_ms, 1))
          send(controller, :run_poll_cycle)
          state = await_idle(controller)
          refute Process.alive?(task.pid)
          refute Map.has_key?(state.running, issue.id)
          assert state.retry_attempts[issue.id].error =~ "stalled for"
        end
      after
        Task.shutdown(task, :brutal_kill)
        if Process.alive?(controller), do: GenServer.stop(controller)
        File.rm_rf!(root)
        refute File.exists?(root)
      end
    end
  end

  defp await_idle(controller, attempts \\ 200) do
    state = :sys.get_state(controller)

    if is_nil(state.tracker_task) and not state.poll_check_in_progress do
      state
    else
      assert attempts > 0, "isolated tracker poll did not complete"
      Process.sleep(10)
      await_idle(controller, attempts - 1)
    end
  end
end
