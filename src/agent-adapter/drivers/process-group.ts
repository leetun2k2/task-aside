// Process group termination and verified-stop proof helper (RF-45, ARCHITECTURE.md §6).
// Architecture boundary: no database access, provider-specific process trees only.
import type { VerificationMethod } from '../../contracts/index.ts';
import type { DriverCancelResult } from './types.ts';

export async function terminateProcessGroup(
  pgid: number,
  termGraceMs = 1000,
  killGraceMs = 500,
): Promise<DriverCancelResult> {
  // 1. Send SIGTERM to the entire process group
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // Process group already gone
  }

  // 2. Poll for group emptiness (ESRCH)
  const deadline = Date.now() + termGraceMs;
  let groupEmpty = false;

  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
      await Bun.sleep(50);
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'ESRCH'
      ) {
        groupEmpty = true;
        break;
      }
    }
  }

  // 3. Escalate to SIGKILL if group not yet empty
  if (!groupEmpty) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Process group already gone
    }

    const killDeadline = Date.now() + killGraceMs;
    while (Date.now() < killDeadline) {
      try {
        process.kill(-pgid, 0);
        await Bun.sleep(50);
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === 'ESRCH'
        ) {
          groupEmpty = true;
          break;
        }
      }
    }
  }

  return {
    verifiedStopped: groupEmpty,
    verificationMethod: 'process_group_empty' as VerificationMethod,
  };
}
