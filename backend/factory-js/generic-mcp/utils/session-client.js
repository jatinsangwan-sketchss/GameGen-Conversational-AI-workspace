/**
 * session-client utils
 * -----------------------------------------------------------------------------
 * Tiny helpers for safely accessing the active MCP client from SessionManager.
 *
 * Kept separate so inventory/executor can share one client-access contract.
 */

function safeString(value) {
  return value == null ? "" : String(value);
}

export function getSessionClient(sessionManager = null) {
  const sm = sessionManager ?? null;
  if (!sm) return null;
  if (typeof sm.getClient === "function") {
    const client = sm.getClient();
    if (client) return client;
  }
  if (sm.client) return sm.client;
  return null;
}

export function describeClientAvailability(sessionManager = null) {
  const sm = sessionManager ?? null;
  if (!sm) return "session manager unavailable";
  const accessor =
    typeof sm.getClient === "function"
      ? () => sm.getClient()
      : () => sm.client;
  if (typeof sm.getClient !== "function" && !Object.prototype.hasOwnProperty.call(sm, "client")) {
    return "session manager missing client accessor";
  }
  const client = accessor();
  if (!client) return "session exists but client is not ready";
  const methods = ["request", "callTool", "toolsCall", "listTools", "toolsList"]
    .filter((name) => typeof client?.[name] === "function")
    .join(", ");
  return methods ? `client methods: ${methods}` : `client attached (${safeString(client?.constructor?.name).trim() || "unknown"})`;
}
