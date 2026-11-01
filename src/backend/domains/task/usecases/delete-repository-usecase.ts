// Delete a registered Git repository (SPECIFICATION.md §6, LC-02b).
import type { Database } from 'bun:sqlite';
import { DomainError } from '../../../errors.ts';
import {
  countTasksForRepository,
  deleteRepository,
  findRepositoryById,
} from '../repositories/git-repository-repository.ts';

export function deleteRepositoryUsecase(db: Database, id: string): void {
  const repository = findRepositoryById(db, id);
  if (!repository) {
    throw new DomainError('NOT_FOUND', `repository not found: ${id}`);
  }

  const taskCount = countTasksForRepository(db, id);
  if (taskCount > 0) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `repository has ${taskCount} task(s); remove or reassign them before deleting it`,
      { repositoryId: id, taskCount },
    );
  }

  deleteRepository(db, id);
}
