// Get Git repository by ID application action (SPECIFICATION.md §6, TASKS.md T11, LC-02b).
import type { Database } from 'bun:sqlite';
import type { Repository } from '../../../../contracts/task.ts';
import { findRepositoryById, rowToRepository } from '../repositories/git-repository-repository.ts';

// Simple read bypasses empty service layer: usecase -> repository
export function getRepositoryUsecase(db: Database, id: string): Repository | null {
  const row = findRepositoryById(db, id);
  return row ? rowToRepository(row) : null;
}
