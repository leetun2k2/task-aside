// List Git repositories application action (SPECIFICATION.md §6, TASKS.md T11, LC-02b).
import type { Database } from 'bun:sqlite';
import type { Repository } from '../../../../contracts/task.ts';
import { findRepositories, rowToRepository } from '../repositories/git-repository-repository.ts';

// Simple read bypasses empty service layer: usecase -> repository
export function listRepositoriesUsecase(db: Database): Repository[] {
  const rows = findRepositories(db);
  return rows.map(rowToRepository);
}
