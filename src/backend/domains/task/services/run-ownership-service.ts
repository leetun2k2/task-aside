// Run ownership/fencing check (LC-05b). Single-run owner/generation
// comparison only; the durable full-scope fencing model is LC-05a-r1, not
// implemented here.
import { DomainError } from '../../../errors.ts';
import type { RunRow } from '../repositories/run-repository.ts';

export function assertRunOwnership(run: RunRow, ownerId: string, generation: number): void {
  if (run.owner_token !== ownerId || run.lock_generation !== generation) {
    throw new DomainError(
      'STALE_GENERATION',
      `owner/generation mismatch for run ${run.id}: expected owner=${run.owner_token} ` +
        `generation=${run.lock_generation}`,
    );
  }
}
