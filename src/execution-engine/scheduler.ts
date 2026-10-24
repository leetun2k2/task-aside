// Execution engine scheduler (ARCHITECTURE.md §5, SPECIFICATION.md §2, §5; TASKS.md T20).
// Enforces P0-P3 priority, FIFO tie-breaking, global concurrency limit (default 3),
// one-per-tree hold, non-stalling scheduling across distinct repos, and non-preemption.
// Architecture boundary: no direct SQLite access in execution engine.
import { randomUUID } from 'node:crypto';
import { MAX_WORKERS } from '../contracts/pool.ts';
import type { TaskPriority } from '../contracts/task.ts';
import { type BackendClient, BackendClientError } from './client.ts';
import type { ActiveRun, ScheduleStepResult, SchedulerOptions, TaskRecord } from './types.ts';

const PRIORITY_RANK: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export const DEFAULT_MAX_CONCURRENCY = MAX_WORKERS;

export function sortRunnableTasks(tasks: TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => {
    const rankA = PRIORITY_RANK[a.priority] ?? 99;
    const rankB = PRIORITY_RANK[b.priority] ?? 99;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    // FIFO tie break on enqueuedAt or createdAt
    const enqueuedA = a.enqueuedAt || a.createdAt;
    const enqueuedB = b.enqueuedAt || b.createdAt;
    const timeA = enqueuedA ? new Date(enqueuedA).getTime() : 0;
    const timeB = enqueuedB ? new Date(enqueuedB).getTime() : 0;
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    return a.id.localeCompare(b.id);
  });
}

export class TaskScheduler {
  private client: BackendClient;
  private ownerId: string;
  private maxConcurrency: number;
  private activeRuns: Map<string, ActiveRun> = new Map(); // runId -> ActiveRun
  private activeWorkingTrees: Map<string, string> = new Map(); // workingTreeKey -> runId
  private repoTreeCache: Map<string, string> = new Map(); // repoId -> canonicalPath
  private activeTaskIds: Set<string> = new Set();
  // Single outstanding-admission-request discipline (specs/2026-10-24-polling
  // -worker-pool.md): one idempotency key per logical admission attempt,
  // reused across retries of that SAME attempt, only replaced once the
  // attempt has definitively resolved (admitted, or a normal "nothing to
  // admit" outcome) — never on a transient failure, so a retry after a
  // network error cannot create a second attempt for the same tick.
  private pendingAdmissionKey: string | null = null;
  private admissionCounter = 0;

  constructor(client: BackendClient, options: SchedulerOptions) {
    this.client = client;
    this.ownerId = options.ownerId;
    this.maxConcurrency = Math.min(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, MAX_WORKERS);
  }

  getOwnerId(): string {
    return this.ownerId;
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  setMaxConcurrency(limit: number): void {
    if (limit < 1) {
      throw new Error(`Invalid maxConcurrency: ${limit}; must be >= 1`);
    }
    // Existing values above MAX_WORKERS remain accepted/stored (settings
    // schema allows up to 10) but never raise the real admitted ceiling.
    this.maxConcurrency = Math.min(limit, MAX_WORKERS);
  }

  async syncSettings(): Promise<void> {
    try {
      const settings = await this.client.getSettings();
      if (settings?.maxConcurrency) {
        this.maxConcurrency = Math.min(settings.maxConcurrency, MAX_WORKERS);
      }
    } catch {
      // Keep current concurrency if backend settings are unreachable
    }
  }

  getActiveRuns(): ActiveRun[] {
    return Array.from(this.activeRuns.values());
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  isTreeBusy(workingTreeKey: string): boolean {
    return this.activeWorkingTrees.has(workingTreeKey);
  }

  isTaskActive(taskId: string): boolean {
    return this.activeTaskIds.has(taskId);
  }

  recordActiveRun(run: ActiveRun): void {
    this.activeRuns.set(run.runId, run);
    this.activeWorkingTrees.set(run.workingTreeKey, run.runId);
    this.activeTaskIds.add(run.taskId);
  }

  releaseRun(runId: string): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) {
      return false;
    }
    this.activeRuns.delete(runId);
    this.activeWorkingTrees.delete(run.workingTreeKey);
    this.activeTaskIds.delete(run.taskId);
    return true;
  }

  /**
   * Evaluates runnable tasks via backend admission (`admitNextTask`),
   * which uses an indexed non-full-backlog SQL query and enforces
   * capacity, tree exclusivity, and priority/FIFO in one atomic call.
   * Uses single outstanding admission request + stable per-attempt idempotency key.
   */
  async scheduleNext(): Promise<ScheduleStepResult> {
    if (this.activeRuns.size >= this.maxConcurrency) {
      return {
        claimed: false,
        skippedReason: 'concurrency_limit_reached',
      };
    }

    if (!this.pendingAdmissionKey) {
      this.admissionCounter++;
      this.pendingAdmissionKey = `${this.ownerId}_admit_${this.admissionCounter}_${randomUUID().slice(0, 8)}`;
    }

    const idempotencyKey = this.pendingAdmissionKey;

    // Do not clear pendingAdmissionKey if admitNextTask throws on network/transport error so retry is idempotent
    const res = await this.client.admitNextTask({
      ownerId: this.ownerId,
      idempotencyKey,
    });

    // Attempt has definitively resolved (admitted, or normal skipped reason)
    this.pendingAdmissionKey = null;

    if (!res.admitted) {
      return {
        claimed: false,
        skippedReason: res.reason,
      };
    }

    const taskId = res.taskSnapshot.id;
    let workingTreeKey = res.workingTreeKey;
    if (!workingTreeKey) {
      const context = await this.client.getTaskContext(taskId);
      workingTreeKey = context.repository.canonicalPath;
    }

    const repoId = res.taskSnapshot.repoId || '';
    if (repoId) {
      this.repoTreeCache.set(repoId, workingTreeKey);
    }

    const activeRun: ActiveRun = {
      runId: res.runId,
      taskId,
      workingTreeKey,
      generation: res.generation,
      priority: res.taskSnapshot.priority,
      startedAt: new Date().toISOString(),
    };

    this.recordActiveRun(activeRun);

    return {
      claimed: true,
      taskId,
      runId: res.runId,
      workingTreeKey,
      generation: res.generation,
    };
  }
}
