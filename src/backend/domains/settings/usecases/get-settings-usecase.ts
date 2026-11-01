// Get settings usecase (SPECIFICATION.md §3, TASKS.md T15, LC-02a).
import type { Database } from 'bun:sqlite';
import type { Provider, Settings } from '../../../../contracts/index.ts';
import { DomainError } from '../../../errors.ts';
import { getSettingsRow } from '../repositories/settings-repository.ts';

// Simple read bypasses empty service layer: usecase -> repository
export function getSettingsUsecase(db: Database): Settings {
  const row = getSettingsRow(db);
  if (!row) {
    throw new DomainError('NOT_FOUND', 'settings record missing');
  }

  let activeHarnesses: Provider[] = ['claude', 'codex', 'agy'];
  if (row.active_harnesses) {
    try {
      const parsed = JSON.parse(row.active_harnesses);
      if (Array.isArray(parsed) && parsed.length > 0) {
        activeHarnesses = parsed as Provider[];
      }
    } catch {
      // fallback to default active harnesses
    }
  }

  return {
    defaultProvider: (row.default_provider as Provider) || 'claude',
    maxConcurrency: row.max_concurrency,
    rootWorkspace: row.root_workspace ?? null,
    activeHarnesses,
    updatedAt: row.updated_at,
  };
}
