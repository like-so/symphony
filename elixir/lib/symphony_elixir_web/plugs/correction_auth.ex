defmodule SymphonyElixirWeb.Plugs.CorrectionAuth do
  @moduledoc false

  import Plug.Conn
  import Phoenix.Controller, only: [json: 2]

  alias SymphonyElixirWeb.Endpoint

  @behaviour Plug

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    token = Endpoint.config(:correction_token)

    cond do
      not present?(token) ->
        reject(conn, 503, "correction_control_unavailable", "Correction control is not configured")

      not loopback_request?(conn) ->
        reject(
          conn,
          403,
          "correction_control_requires_local_transport",
          "Correction control requires a loopback client or same-host TLS proxy"
        )

      authorized?(conn, token) ->
        conn

      true ->
        reject(conn, 401, "unauthorized", "Unauthorized")
    end
  end

  defp authorized?(conn, expected) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> provided] when byte_size(provided) == byte_size(expected) ->
        Plug.Crypto.secure_compare(provided, expected)

      _ ->
        false
    end
  end

  defp reject(conn, status, code, message) do
    conn
    |> put_status(status)
    |> json(%{error: %{code: code, message: message}})
    |> halt()
  end

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(_value), do: false

  defp loopback_request?(%Plug.Conn{remote_ip: {127, _, _, _}}), do: true
  defp loopback_request?(%Plug.Conn{remote_ip: {0, 0, 0, 0, 0, 0, 0, 1}}), do: true

  defp loopback_request?(%Plug.Conn{remote_ip: {0, 0, 0, 0, 0, 65_535, high, _}})
       when high >= 0x7F00 and high <= 0x7FFF,
       do: true

  defp loopback_request?(_conn), do: false
end
