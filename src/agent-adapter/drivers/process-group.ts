// Process group termination and verified-stop proof helper (RF-45, ARCHITECTURE.md §6, LC-05c-p).
// Architecture boundary: no database access, provider-specific process trees only.
//
// Known limitation (LC-05c-p, not solved here): this only confirms the
// process group rooted at `pgid` is gone. A descendant that escaped the
// group (e.g. called setsid()) or was reparented to init before the group
// leader exited is invisible to a pgid-based signal-0 probe — catching that
// would require tracking descendant PIDs proactively from spawn time, which
// this codebase does not do. `verifiedStopped: true` here means "the
// original process group is confirmed empty," not "every descendant process
// anywhere is confirmed gone."
import type { VerificationMethod } from '../../contracts/index.ts';
import type { DriverCancelResult } from './types.ts';

type GroupState = 'empty' | 'alive' | 'uncertain';

function probeGroupState(pgid: number): GroupState {
  try {
    process.kill(-pgid, 0);
    return 'alive';
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : undefined;
    if (code === 'ESRCH') {
      return 'empty';
    }
    // EPERM (group exists, we lack permission to signal it) or any other
    // unexpected error: never treat as empty — this is the "ESRCH is
    // distinct from permission errors" requirement.
    return 'uncertain';
  }
}

async function pollUntilEmpty(pgid: number, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const state = probeGroupState(pgid);
    if (state === 'empty') {
      return true;
    }
    await Bun.sleep(50);
  }
  return probeGroupState(pgid) === 'empty';
}

/** Active termination (cancel/timeout): sends signals, escalates to SIGKILL. */
export async function terminateProcessGroup(
  pgid: number,
  termGraceMs = 1000,
  killGraceMs = 500,
): Promise<DriverCancelResult> {
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // Process group already gone
  }

  let groupEmpty = await pollUntilEmpty(pgid, termGraceMs);

  if (!groupEmpty) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Process group already gone
    }
    groupEmpty = await pollUntilEmpty(pgid, killGraceMs);
  }

  return {
    verifiedStopped: groupEmpty,
    verificationMethod: 'process_group_empty' as VerificationMethod,
  };
}

/**
 * Passive verification (natural completion): the direct child already exited
 * on its own (a Node `close` event fired), so no signal is sent here — doing
 * so could target a since-recycled pgid number. Only confirms the group is
 * already empty.
 */
export async function verifyGroupAlreadyStopped(
  pgid: number,
  graceMs = 200,
): Promise<DriverCancelResult> {
  const groupEmpty = await pollUntilEmpty(pgid, graceMs);
  return {
    verifiedStopped: groupEmpty,
    verificationMethod: 'process_group_empty' as VerificationMethod,
  };
}
