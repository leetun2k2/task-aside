// Git repository database access (SPECIFICATION.md §6, TASKS.md T11, LC-02b).
import type { Database } from 'bun:sqlite';
import type { Provider, Repository } from '../../../../contracts/task.ts';

export interface RepositoryRow {
  id: string;
  name: string;
  display_path: string;
  canonical_path: string;
  default_provider: string;
  created_at: string;
}

export function rowToRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    name: row.name,
    displayPath: row.display_path,
    canonicalPath: row.canonical_path,
    defaultProvider: row.default_provider as Provider,
    createdAt: row.created_at,
  };
}

export function findRepositoryByCanonicalPath(
  db: Database,
  canonicalPath: string,
): { id: string } | null {
  return db.query('SELECT id FROM repositories WHERE canonical_path = ?').get(canonicalPath) as {
    id: string;
  } | null;
}

export function insertRepository(
  db: Database,
  repo: {
    id: string;
    name: string;
    displayPath: string;
    canonicalPath: string;
    defaultProvider: string;
    createdAt: string;
  },
): void {
  db.query(
    `INSERT INTO repositories (id, name, display_path, canonical_path, default_provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    repo.id,
    repo.name,
    repo.displayPath,
    repo.canonicalPath,
    repo.defaultProvider,
    repo.createdAt,
  );
}

export function findRepositories(db: Database): RepositoryRow[] {
  return db
    .query(
      `SELECT id, name, display_path, canonical_path, default_provider, created_at
       FROM repositories ORDER BY created_at ASC, id ASC`,
    )
    .all() as RepositoryRow[];
}

export function findRepositoryById(db: Database, id: string): RepositoryRow | null {
  return db
    .query(
      `SELECT id, name, display_path, canonical_path, default_provider, created_at
       FROM repositories WHERE id = ?`,
    )
    .get(id) as RepositoryRow | null;
}

export function countTasksForRepository(db: Database, repositoryId: string): number {
  const row = db
    .query('SELECT COUNT(*) AS count FROM tasks WHERE repository_id = ?')
    .get(repositoryId) as { count: number };
  return row.count;
}

export function deleteRepository(db: Database, id: string): void {
  db.query('DELETE FROM repositories WHERE id = ?').run(id);
}
