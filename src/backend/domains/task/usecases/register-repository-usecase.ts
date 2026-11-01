// Register Git repository application action (SPECIFICATION.md §6, TASKS.md T11, LC-02b).
import type { Database } from 'bun:sqlite';
import type { CreateRepositoryInput, Repository } from '../../../../contracts/task.ts';
import { insertRepository } from '../repositories/git-repository-repository.ts';
import {
  assertNoDuplicateRepository,
  assertWithinRootWorkspace,
  prepareRepositoryRegistration,
} from '../services/git-repository-service.ts';

export function registerRepositoryUsecase(db: Database, input: CreateRepositoryInput): Repository {
  const prepared = prepareRepositoryRegistration(input);
  assertWithinRootWorkspace(db, prepared.canonicalPath);
  assertNoDuplicateRepository(db, prepared.canonicalPath);
  insertRepository(db, prepared);

  return {
    id: prepared.id,
    name: prepared.name,
    displayPath: prepared.displayPath,
    canonicalPath: prepared.canonicalPath,
    defaultProvider: prepared.defaultProvider as Repository['defaultProvider'],
    createdAt: prepared.createdAt,
  };
}
