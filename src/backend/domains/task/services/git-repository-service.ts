// Git repository domain service (SPECIFICATION.md §6, TASKS.md T11, LC-02b).
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import type { CreateRepositoryInput } from '../../../../contracts/task.ts';
import { canonicalizePath } from '../../../canonical-path.ts';
import { DomainError } from '../../../errors.ts';
import { getSettingsRow } from '../../settings/repositories/settings-repository.ts';
import { findRepositoryByCanonicalPath } from '../repositories/git-repository-repository.ts';

export function assertWithinRootWorkspace(db: Database, canonicalPath: string): void {
  const settings = getSettingsRow(db);
  if (settings?.root_workspace) {
    const rootCanonical = canonicalizePath(settings.root_workspace).canonicalPath;
    const rel = relative(rootCanonical, canonicalPath);
    const isInside = !rel.startsWith('..') && !isAbsolute(rel);
    if (!isInside) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `repository path '${canonicalPath}' is outside the configured root workspace: ${settings.root_workspace}`,
        { rootWorkspace: settings.root_workspace, canonicalPath },
      );
    }
  }
}

export function assertNoDuplicateRepository(db: Database, canonicalPath: string): void {
  const existing = findRepositoryByCanonicalPath(db, canonicalPath);
  if (existing) {
    throw new DomainError(
      'SEQUENCE_CONFLICT',
      `a repository is already registered at this location: ${canonicalPath}`,
      { canonicalPath },
    );
  }
}

export function prepareRepositoryRegistration(input: CreateRepositoryInput): {
  id: string;
  name: string;
  displayPath: string;
  canonicalPath: string;
  defaultProvider: string;
  createdAt: string;
} {
  const { canonicalPath, displayPath } = canonicalizePath(input.displayPath);
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  return {
    id,
    name: input.name,
    displayPath,
    canonicalPath,
    defaultProvider: input.defaultProvider,
    createdAt,
  };
}
