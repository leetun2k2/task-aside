// Heartbeat ownership action (LC-05b): renews a run's lease and every lock
// it holds in one immediate transaction, closing the read-before-transaction
// window the previous inline implementation had.
import type { Database } from 'bun:sqlite';
import type { HeartbeatRequest } from '../../../../contracts/run.ts';
import { DomainError } from '../../../errors.ts';
import { getLocksForRun, refreshLockLeasesForRun } from '../repositories/lock-repository.ts';
import { refreshRunHeartbeat, requireRun } from '../repositories/run-repository.ts';
import { LEASE_DURATION_MS } from '../runs.ts';
import { assertRunOwnership } from '../services/run-ownership-service.ts';

export function heartbeatUsecase(
  db: Database,
  runId: string,
  request: HeartbeatRequest,
): { ok: true } {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();

  const applyAtomically = db.transaction(() => {
    const run = requireRun(db, runId);
    assertRunOwnership(run, request.ownerId, request.generation);

    const locks = getLocksForRun(db, runId);
    if (run.purpose !== 'intake' && locks.length === 0) {
      throw new DomainError('STALE_GENERATION', `no locks found for run ${runId}`);
    }

    refreshRunHeartbeat(db, runId, now);
    if (locks.length > 0) {
      refreshLockLeasesForRun(db, runId, leaseExpiresAt, now);
    }
  });
  applyAtomically.immediate();

  return { ok: true };
}
