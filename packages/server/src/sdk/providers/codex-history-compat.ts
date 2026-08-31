/**
 * Compatibility classifiers for Codex paginated-history protocol controls.
 *
 * Keep these checks narrow. In particular, a generic JSON-RPC `-32602` can
 * describe an invalid lifecycle request and must not silently downgrade the
 * client to full-history hydration. The accepted wording mirrors Codex TUI's
 * `is_history_pagination_unsupported` classifier at reference commit
 * a9519cbcdd2d664530edb2469224ee03c1056799.
 */

const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

interface JsonRpcErrorLike {
  code: number;
  message: string;
}

function asJsonRpcErrorLike(error: unknown): JsonRpcErrorLike | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; message?: unknown };
  if (
    typeof candidate.code !== "number" ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }
  return { code: candidate.code, message: candidate.message };
}

/**
 * Whether a lifecycle request was rejected specifically because the server
 * does not understand `excludeTurns`.
 */
export function isCodexLifecycleExcludeTurnsUnsupported(
  error: unknown,
): boolean {
  const rpcError = asJsonRpcErrorLike(error);
  if (
    !rpcError ||
    (rpcError.code !== JSON_RPC_INVALID_REQUEST &&
      rpcError.code !== JSON_RPC_INVALID_PARAMS)
  ) {
    return false;
  }

  const message = rpcError.message.toLowerCase();
  return ["excludeturns", "exclude turns", "exclude_turns"].some((field) =>
    message.includes(field),
  );
}

/** Whether a lifecycle request was rejected for `initialTurnsPage`. */
export function isCodexLifecycleInitialTurnsPageUnsupported(
  error: unknown,
): boolean {
  const rpcError = asJsonRpcErrorLike(error);
  if (
    !rpcError ||
    (rpcError.code !== JSON_RPC_INVALID_REQUEST &&
      rpcError.code !== JSON_RPC_INVALID_PARAMS)
  ) {
    return false;
  }

  const message = rpcError.message.toLowerCase();
  return ["initialturnspage", "initial turns page", "initial_turns_page"].some(
    (field) => message.includes(field),
  );
}

export function isCodexLifecycleHistoryControlsUnsupported(
  error: unknown,
): boolean {
  return (
    isCodexLifecycleExcludeTurnsUnsupported(error) ||
    isCodexLifecycleInitialTurnsPageUnsupported(error)
  );
}

/**
 * Codex 0.151 reports a completed-before-steer race as invalid request. Match
 * the stable reason exactly so unrelated input/identity errors never start a
 * competing turn.
 */
export function isCodexNoActiveTurnToSteer(error: unknown): boolean {
  const rpcError = asJsonRpcErrorLike(error);
  return (
    rpcError !== null &&
    (rpcError.code === JSON_RPC_INVALID_REQUEST ||
      rpcError.code === JSON_RPC_INVALID_PARAMS) &&
    rpcError.message.trim().toLowerCase() === "no active turn to steer"
  );
}

/**
 * Whether a request proves that the app-server lacks paginated-history
 * protocol support. Method-not-found is accepted because this classifier is
 * used around paging methods themselves; other request failures must name a
 * paging field/method or an unsupported `paginated` enum value.
 */
export function isCodexHistoryPaginationUnsupported(error: unknown): boolean {
  const rpcError = asJsonRpcErrorLike(error);
  if (!rpcError) return false;
  if (rpcError.code === JSON_RPC_METHOD_NOT_FOUND) return true;
  if (
    rpcError.code !== JSON_RPC_INVALID_REQUEST &&
    rpcError.code !== JSON_RPC_INVALID_PARAMS
  ) {
    return false;
  }

  const message = rpcError.message.toLowerCase();
  if (
    [
      "historymode",
      "history mode",
      "history_mode",
      "excludeturns",
      "exclude turns",
      "exclude_turns",
      "thread/turns/list",
      "thread/items/list",
    ].some((field) => message.includes(field))
  ) {
    return true;
  }

  return (
    message.includes("paginated") &&
    ["unknown variant", "unsupported variant", "invalid enum"].some((reason) =>
      message.includes(reason),
    )
  );
}
