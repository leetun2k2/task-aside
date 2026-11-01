import { verifyGroupAlreadyStopped } from '../drivers/process-group.ts';
// Stop-proof decision policy (LC-05c-p): the single place that decides
// whether verifiedStopped/verificationMethod may be stamped onto a run.
// Never fabricates proof — a negative/uncertain verification leaves the
// fields null so downstream consumers (execution-engine's existing
// poll-then-markUncertain logic) treat the run as unresolved.
import type { DriverCancelResult } from '../drivers/types.ts';
import type { AdapterRun } from '../types.ts';

/** Natural completion (close/error, no signal sent): verify the already-exited
 * process group is actually empty. No process group ever assigned (start()
 * failed before spawning) is trivially "stopped" — there was never anything
 * to verify. */
export async function verifyNaturalStop(pgid: number | undefined): Promise<DriverCancelResult> {
  if (!pgid) {
    return { verifiedStopped: true, verificationMethod: 'process_group_empty' };
  }
  return verifyGroupAlreadyStopped(pgid);
}

/** Only stamps proof when verification actually succeeded. */
export function stampVerifiedStop(run: AdapterRun, result: DriverCancelResult): void {
  if (result.verifiedStopped) {
    run.verifiedStoppedAt = new Date().toISOString();
    run.verificationMethod = result.verificationMethod;
  }
}

/** Clears any leftover proof from a prior launch (e.g. an earlier HITL turn)
 * so it can never be reused to finalize a new launch. */
export function resetLaunchProof(run: AdapterRun): void {
  run.verifiedStoppedAt = null;
  run.verificationMethod = null;
}
