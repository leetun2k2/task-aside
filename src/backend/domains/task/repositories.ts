// Repository domain (SPECIFICATION.md §6, T11): registers repos behind a
// safe canonical path so aliased/symlinked paths cannot double-register.
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { CreateRepositoryInput, Provider, Repository } from '../../../contracts/task.ts';
import { DomainError } from '../../api/errors.ts';
import { canonicalizePath } from '../../canonical-path.ts';

interface RepositoryRow {
  id: string;
  name: string;
  display_path: string;
  canonical_path: string;
  default_provider: string;
  created_at: string;
}

function rowToRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    name: row.name,
    displayPath: row.display_path,
    canonicalPath: row.canonical_path,
    defaultProvider: row.default_provider as Provider,
    createdAt: row.created_at,
  };
}

export function createRepository(db: Database, input: CreateRepositoryInput): Repository {
  const { canonicalPath, displayPath } = canonicalizePath(input.displayPath);

  const existing = db
    .query('SELECT id FROM repositories WHERE canonical_path = ?')
    .get(canonicalPath) as { id: string } | null;
  if (existing) {
    throw new DomainError(
      'SEQUENCE_CONFLICT',
      `a repository is already registered at this location: ${canonicalPath}`,
      { canonicalPath },
    );
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.query(
    `INSERT INTO repositories (id, name, display_path, canonical_path, default_provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, displayPath, canonicalPath, input.defaultProvider, createdAt);

  return {
    id,
    name: input.name,
    displayPath,
    canonicalPath,
    defaultProvider: input.defaultProvider,
    createdAt,
  };
}

export function listRepositories(db: Database): Repository[] {
  const rows = db
    .query(
      `SELECT id, name, display_path, canonical_path, default_provider, created_at
       FROM repositories ORDER BY created_at ASC, id ASC`,
    )
    .all() as RepositoryRow[];
  return rows.map(rowToRepository);
}

export function getRepositoryById(db: Database, id: string): Repository | null {
  const row = db
    .query(
      `SELECT id, name, display_path, canonical_path, default_provider, created_at
       FROM repositories WHERE id = ?`,
    )
    .get(id) as RepositoryRow | null;
  return row ? rowToRepository(row) : null;
}
