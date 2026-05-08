/**
 * Broker protocol constants — env var name for the broker endpoint, the
 * JSON-RPC error code reserved for "broker busy", and the max-line buffer
 * size used by the JSON-RPC line framer (refuse JSON frames bigger than
 * this rather than blow up memory on a runaway producer).
 *
 * Extracted from the retired `acp-client.mjs` so consumers don't need to
 * import a dead class to get a constant.
 */

/** Env var name for the broker socket endpoint, set on hosts that run a broker. */
export const BROKER_ENDPOINT_ENV = "GEMINI_COMPANION_ACP_ENDPOINT";

/** JSON-RPC error code returned by the broker when it can't accept a new client. */
export const BROKER_BUSY_RPC_CODE = -32001;

/** Maximum bytes a single JSON-RPC line may grow to before the framer drops it (1 MiB). */
export const ACP_MAX_LINE_BUFFER = 1 << 20;
