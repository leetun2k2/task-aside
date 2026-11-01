// Task admission database access (SPECIFICATION.md §2, LC-05a).
import type { Database } from 'bun:sqlite';
import { TASK_COLUMNS, type TaskRow } from '../tasks.ts';

export function findNextEligibleTaskId(db: Database): string | null {
  const candidates = db
    .query(
      `SELECT t.id, t.stage, t.repository_id, t.resolved_repo_ids
       FROM tasks t
       WHERE t.status = 'todo' AND t.block_kind IS NULL
       ORDER BY t.priority ASC, t.enqueued_at ASC, t.id ASC`,
    )
    .all() as {
    id: string;
    stage: string;
    repository_id: string | null;
    resolved_repo_ids: string | null;
  }[];

  for (const c of candidates) {
    if (c.stage === 'intake') {
      return c.id;
    }

    // Check implementation scope
    let repoIds: string[] = [];
    if (c.resolved_repo_ids) {
      try {
        repoIds = JSON.parse(c.resolved_repo_ids) as string[];
      } catch {}
    }
    if (repoIds.length === 0 && c.repository_id) {
      repoIds = [c.repository_id];
    }
    if (repoIds.length === 0) {
      continue;
    }

    // Check if any of these repos are busy or quarantined
    let busyOrQuarantined = false;
    for (const rid of repoIds) {
      const repo = db.query('SELECT canonical_path FROM repositories WHERE id = ?').get(rid) as {
        canonical_path: string;
      } | null;
      if (!repo) {
        busyOrQuarantined = true;
        break;
      }
      const lock = db
        .query(
          `SELECT rl.quarantined, rl.owner_run_id, r.status as run_status
           FROM run_locks rl
           LEFT JOIN runs r ON r.id = rl.owner_run_id
           WHERE rl.working_tree_key = ?`,
        )
        .get(repo.canonical_path) as {
        quarantined: number;
        owner_run_id: string;
        run_status: string | null;
      } | null;

      if (lock) {
        if (lock.quarantined === 1) {
          busyOrQuarantined = true;
          break;
        }
        if (
          lock.owner_run_id &&
          lock.owner_run_id !== '' &&
          lock.run_status &&
          ['running', 'hitl', 'uncertain'].includes(lock.run_status)
        ) {
          busyOrQuarantined = true;
          break;
        }
      }
    }

    if (!busyOrQuarantined) {
      return c.id;
    }
  }

  return null;
}

export function countRunnableTasks(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) as count FROM tasks WHERE status = 'todo' AND block_kind IS NULL")
    .get() as { count: number };
  return row.count;
}

export function findRunnableTasks(db: Database): TaskRow[] {
  return db
    .query(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE status = 'todo' AND block_kind IS NULL
       ORDER BY enqueued_at ASC`,
    )
    .all() as TaskRow[];
}
