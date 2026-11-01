// Repository domain compatibility exports (SPECIFICATION.md §6, T11, LC-02b).
import type { Database } from 'bun:sqlite';
import type { CreateRepositoryInput, Repository } from '../../../contracts/task.ts';
import { getRepositoryUsecase } from './usecases/get-repository-usecase.ts';
import { listRepositoriesUsecase } from './usecases/list-repositories-usecase.ts';
import { registerRepositoryUsecase } from './usecases/register-repository-usecase.ts';

export function createRepository(db: Database, input: CreateRepositoryInput): Repository {
  return registerRepositoryUsecase(db, input);
}

export function listRepositories(db: Database): Repository[] {
  return listRepositoriesUsecase(db);
}

export function getRepositoryById(db: Database, id: string): Repository | null {
  return getRepositoryUsecase(db, id);
}
