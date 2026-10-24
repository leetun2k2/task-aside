// Execution engine run reconciler (ARCHITECTURE.md §2.2, §5; SPECIFICATION.md §3, §7; TASKS.md T22).
// Safely reconciles unfinalized runs against adapter process states:
// - Terminal adapter state with verified stopped proof -> finalize on backend & release lock.
// - Adapter missing run (404), unreachable, or unverified stop -> mark-uncertain & quarantine lock.
// - Cancel active run -> cancel on adapter; on verified stop finalize as cancelled; on failure mark-uncertain.
// Architecture boundary: no direct SQLite access and no provider subprocess spawn.
import {
  type AdapterClient,
  AdapterClientError,
  type BackendClient,
  BackendClientError,
} from './client.ts';
import type { TaskScheduler } from './scheduler.ts';
import type { CancelAndReconcileResult, ReconcileRunResult, ReconcilerOptions } from './types.ts';

export class RunReconciler {
  private backendClient: BackendClient;
  private adapterClient: AdapterClient;
  private scheduler: TaskScheduler;
  private options: ReconcilerOptions;

  constructor(
    backendClient: BackendClient,
    adapterClient: AdapterClient,
    scheduler: TaskScheduler,
    options: ReconcilerOptions,
  ) {
    this.backendClient = backendClient;
    this.adapterClient = adapterClient;
    this.scheduler = scheduler;
    this.options = options;
  }

  /**
   * Reconciles a single run against adapter state.
   * If adapter confirms terminal status with verified stopped proof, finalizes run on backend.
   * If adapter has lost run state (404) or cannot be reached, marks run uncertain and quarantines lock.
   *
   * Fencing note (specs/2026-10-24-handoff-single-writer.md A9): after a
   * process restart this engine's own identity (`this.options.ownerId`, e.g.
   * `engine_${pid}`) will NOT match the run's stored owner — calling
   * finalize/markUncertain with it would be rejected as a stale/mismatched
   * owner. This is not owner impersonation: we fetch the run's OWN current
   * owner/generation from the backend and use those as the fencing
   * credentials, and only act after independent adapter process evidence
   * (terminal+verified-stop, or missing/unreachable) — never advancing the
   * generation or starting a second provider process. The `generation`
   * parameter is kept for caller compatibility but the freshly-fetched value
   * is authoritative.
   */
  async reconcileRun(runId: string, _generation: number): Promise<ReconcileRunResult> {
    let ownerId = this.options.ownerId;
    let generation = _generation;
    try {
      const runRecord = await this.backendClient.getRun(runId);
      ownerId = runRecord.ownerId;
      generation = runRecord.generation;
    } catch {
      // Run no longer exists or backend unreachable — fall through using the
      // caller-supplied values; the subsequent adapter/backend calls will
      // surface the real failure.
    }

    try {
      const adapterStatus = await this.adapterClient.getRunStatus(runId);
      const processState = adapterStatus.processState;
      const status = processState.status;

      if (status === 'done' || status === 'error' || status === 'cancelled') {
        const verifiedStopped = processState.verifiedStoppedAt !== null;
        if (verifiedStopped) {
          await this.backendClient.finalize(runId, {
            ownerId,
            generation,
            status,
            verifiedStopped: true,
            verificationMethod: processState.verificationMethod ?? 'process_group_empty',
          });
          this.scheduler.releaseRun(runId);
          return {
            runId,
            reconciled: true,
            status,
            quarantined: false,
            verifiedStopped: true,
          };
        }

        // Terminal status without verified stopped proof: mark uncertain to protect repository
        await this.backendClient.markUncertain(runId, {
          ownerId,
          generation,
          reason: 'Reconciliation: terminal status reported without verified stopped proof',
        });
        this.scheduler.releaseRun(runId);
        return {
          runId,
          reconciled: true,
          status: 'uncertain',
          quarantined: true,
          verifiedStopped: false,
        };
      }

      // Still running or waiting in hitl
      return {
        runId,
        reconciled: false,
        status,
        quarantined: false,
        verifiedStopped: false,
      };
    } catch (err: unknown) {
      // Adapter returned 404 (crashed/rebooted) or connection failed:
      // We cannot prove old process stopped -> mark uncertain to quarantine lock!
      const reason = err instanceof Error ? err.message : 'Adapter unreachable or run state lost';
      try {
        await this.backendClient.markUncertain(runId, {
          ownerId,
          generation,
          reason: `Reconciliation fault: ${reason}`,
        });
      } catch {
        // Backend markUncertain may fail if already finalized or generation mismatch
      }
      this.scheduler.releaseRun(runId);
      return {
        runId,
        reconciled: true,
        status: 'uncertain',
        quarantined: true,
        verifiedStopped: false,
        error: reason,
      };
    }
  }

  /**
   * Cancels an active run on the adapter and reconciles backend state.
   * If adapter terminates process tree and proves verified stopped, finalizes as cancelled.
   * If adapter fails or cannot prove process stopped, marks run uncertain and quarantines lock.
   */
  async cancelAndReconcile(runId: string, _generation: number): Promise<CancelAndReconcileResult> {
    let ownerId = this.options.ownerId;
    let generation = _generation;
    try {
      const runRecord = await this.backendClient.getRun(runId);
      ownerId = runRecord.ownerId;
      generation = runRecord.generation;
    } catch {
      // Fall through with caller-supplied values; the adapter/backend calls
      // below will surface the real failure.
    }

    try {
      const cancelRes = await this.adapterClient.cancelRun(runId, {
        ownerId,
        generation,
      });

      if (cancelRes.verifiedStopped) {
        await this.backendClient.finalize(runId, {
          ownerId,
          generation,
          status: 'cancelled',
          verifiedStopped: true,
          verificationMethod: cancelRes.verificationMethod ?? 'process_group_empty',
        });
        this.scheduler.releaseRun(runId);
        return {
          runId,
          cancelled: true,
          verifiedStopped: true,
          quarantined: false,
          status: 'cancelled',
        };
      }
    } catch {
      // Adapter cancel threw or process could not be terminated cleanly
    }

    // Cancel failed to verify process termination: mark uncertain to prevent concurrent writer
    try {
      await this.backendClient.markUncertain(runId, {
        ownerId,
        generation,
        reason: 'Cancel failed: could not verify process tree stopped',
      });
    } catch {
      // Backend markUncertain may fail if already finalized or generation mismatch
    }
    this.scheduler.releaseRun(runId);
    return {
      runId,
      cancelled: false,
      verifiedStopped: false,
      quarantined: true,
      status: 'uncertain',
    };
  }
}
