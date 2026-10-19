defmodule SymphonyElixir.Codex.ProviderWait do
  @moduledoc """
  Tracks the first wait of each provider request on an ordered native event stream.
  Starting a wait does not count as activity; its matching end restarts inactivity timing once.
  Deadlines use the producer's configured budget and a shared Unix clock, not a new global cap.
  """

  @method "turn/providerFirstWait"
  @type wait_state :: %{trace_id: String.t(), deadline_ms: integer() | nil} | nil

  @spec notification?(map()) :: boolean()
  def notification?(%{payload: %{"method" => @method}}), do: true
  def notification?(_update), do: false

  @spec activity_timestamp(wait_state(), map(), DateTime.t() | nil, DateTime.t()) :: DateTime.t() | nil
  def activity_timestamp(current, update, previous, timestamp) do
    case update do
      %{payload: %{"method" => @method, "params" => %{"phase" => "ended", "trace_id" => id}}} ->
        if match?(%{trace_id: ^id, deadline_ms: deadline} when is_integer(deadline), current) do
          timestamp
        else
          previous
        end

      _ ->
        if notification?(update), do: previous, else: timestamp
    end
  end

  @spec update(wait_state(), map()) :: wait_state()
  def update(current, %{timestamp: %DateTime{} = received_at, payload: %{"method" => @method, "params" => params}}) do
    case params do
      %{"phase" => "started", "trace_id" => id, "timeout_ms" => timeout, "deadline_unix_ms" => deadline} ->
        start_wait(current, id, timeout, deadline, received_at)

      %{"phase" => "ended", "trace_id" => id} ->
        case current do
          %{trace_id: ^id} -> %{trace_id: id, deadline_ms: nil}
          _ -> current
        end

      _ ->
        current
    end
  end

  def update(_current, %{event: event}) when event in [:turn_completed, :turn_failed, :turn_cancelled], do: nil
  def update(current, _update), do: current

  defp start_wait(current, id, timeout, deadline, received_at)
       when is_binary(id) and byte_size(id) > 0 and is_integer(timeout) and timeout > 0 and
              is_integer(deadline) and deadline > 0 do
    # The producer rounds the remaining monotonic budget up to a millisecond.
    if match?(%{trace_id: ^id}, current) or
         deadline > DateTime.to_unix(received_at, :millisecond) + timeout + 1 do
      current
    else
      %{trace_id: id, deadline_ms: deadline}
    end
  end

  defp start_wait(current, _id, _timeout, _deadline, _received_at), do: current

  @spec pending?(wait_state(), DateTime.t()) :: boolean()
  def pending?(%{deadline_ms: deadline}, %DateTime{} = now) when is_integer(deadline),
    do: DateTime.to_unix(now, :millisecond) < deadline

  def pending?(_current, _now), do: false
end
