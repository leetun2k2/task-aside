// Shared polling/worker-pool constants (specs/2026-10-24-polling-worker-pool.md).
// Used by both `src/backend` (admission/capacity/deadline enforcement) and
// `src/execution-engine` (scheduling cadence) without either importing the
// other — this module has zero dependencies on either side.
export const MAX_WORKERS = 8;
export const POLL_INTERVAL_MS = 100;
export const CONTROL_INTERVAL_MS = 1_000;
export const TASK_TIMEOUT_MS = 60 * 60 * 1000;
export const SHUTDOWN_DRAIN_MS = 30_000;
export const STOP_VERIFICATION_BOUND_MS = 5_000;
/** Bounds control-plane HTTP requests only — never applied to SSE streams. */
export const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
export const BACKOFF_MIN_MS = 250;
export const BACKOFF_MAX_MS = 5_000;
