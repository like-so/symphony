defmodule SymphonyElixirWeb.CorrectionController do
  @moduledoc """
  Authenticated delivery and status API for corrections bound to active workers.
  """

  use Phoenix.Controller, formats: [:json]

  alias Plug.Conn
  alias SymphonyElixir.Orchestrator
  alias SymphonyElixirWeb.Endpoint

  @max_instruction_bytes 32_768
  @max_identifier_bytes 256
  @max_workspace_bytes 4_096

  @spec create(Conn.t(), map()) :: Conn.t()
  def create(conn, %{"issue_identifier" => issue_identifier} = params) do
    with {:ok, correction} <- correction_from_params(issue_identifier, params),
         {:ok, record} <- Orchestrator.queue_correction(orchestrator(), correction) do
      conn
      |> put_resp_header("location", "/api/v1/corrections/#{URI.encode(record.instruction_id)}")
      |> put_status(202)
      |> json(correction_payload(record))
    else
      {:error, :invalid_correction} ->
        error_response(conn, 422, "invalid_correction", "Correction payload is invalid")

      {:error, :duplicate_instruction_id} ->
        error_response(conn, 409, "duplicate_instruction_id", "Instruction ID was already used")

      {:error, :stale_owner} ->
        error_response(conn, 404, "active_owner_not_found", "Active issue owner was not found")

      {:error, :owner_binding_mismatch} ->
        error_response(conn, 409, "owner_binding_mismatch", "Active issue owner binding does not match")

      {:error, :unsupported_correction_transport} ->
        error_response(
          conn,
          409,
          "unsupported_correction_transport",
          "Active issue owner transport does not support correction delivery"
        )

      {:error, :unavailable} ->
        error_response(conn, 503, "orchestrator_unavailable", "Orchestrator is unavailable")
    end
  end

  @spec show(Conn.t(), map()) :: Conn.t()
  def show(conn, %{"instruction_id" => instruction_id}) do
    case Orchestrator.correction_status(orchestrator(), instruction_id) do
      {:ok, record} ->
        json(conn, correction_payload(record))

      {:error, :not_found} ->
        error_response(conn, 404, "correction_not_found", "Correction was not found")

      {:error, :unavailable} ->
        error_response(conn, 503, "orchestrator_unavailable", "Orchestrator is unavailable")
    end
  end

  defp correction_from_params(issue_identifier, %{
         "instruction_id" => instruction_id,
         "instruction" => instruction,
         "target" => %{
           "issue_id" => issue_id,
           "session_id" => session_id,
           "workspace_path" => workspace_path,
           "worker_pid" => worker_pid,
           "worker_host" => worker_host
         }
       }) do
    if valid_identifier?(issue_identifier) and valid_identifier?(instruction_id) and
         valid_identifier?(issue_id) and valid_identifier?(session_id) and
         valid_workspace?(workspace_path) and valid_worker_pid?(worker_pid) and
         valid_worker_host?(worker_host) and
         valid_instruction?(instruction) do
      {:ok,
       %{
         instruction_id: instruction_id,
         issue_id: issue_id,
         issue_identifier: issue_identifier,
         session_id: session_id,
         workspace_path: workspace_path,
         worker_pid: worker_pid,
         worker_host: worker_host,
         text: instruction
       }}
    else
      {:error, :invalid_correction}
    end
  end

  defp correction_from_params(_issue_identifier, _params), do: {:error, :invalid_correction}

  defp correction_payload(record) do
    %{
      instruction_id: record.instruction_id,
      issue_id: record.issue_id,
      issue_identifier: record.issue_identifier,
      session_id: record.session_id,
      workspace_path: record.workspace_path,
      worker_pid: record.worker_pid,
      worker_host: record.worker_host,
      status: record.status,
      queued_at: record.queued_at,
      updated_at: record.updated_at,
      run_id: Map.get(record, :run_id),
      result: record.result,
      error: record.error
    }
  end

  defp error_response(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{error: %{code: code, message: message}})
  end

  defp orchestrator do
    Endpoint.config(:orchestrator) || Orchestrator
  end

  defp valid_identifier?(value) when is_binary(value) do
    valid_string?(value, @max_identifier_bytes) and String.match?(value, ~r/^[A-Za-z0-9._:-]+$/)
  end

  defp valid_identifier?(_value), do: false
  defp valid_workspace?(value), do: valid_string?(value, @max_workspace_bytes)
  defp valid_instruction?(value), do: valid_string?(value, @max_instruction_bytes)
  defp valid_worker_pid?(value) when is_binary(value), do: String.match?(value, ~r/^[1-9][0-9]*$/)
  defp valid_worker_pid?(_value), do: false
  defp valid_worker_host?(nil), do: true
  defp valid_worker_host?(value), do: valid_string?(value, @max_identifier_bytes)

  defp valid_string?(value, max_bytes) when is_binary(value) do
    byte_size(value) <= max_bytes and String.trim(value) != ""
  end

  defp valid_string?(_value, _max_bytes), do: false
end
