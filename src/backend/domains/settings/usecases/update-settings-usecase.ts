// Update settings usecase (SPECIFICATION.md §3, TASKS.md T15, LC-02a).
import type { Database } from 'bun:sqlite';
import type { Settings, UpdateSettingsInput } from '../../../../contracts/index.ts';
import { updateSettingsRow } from '../repositories/settings-repository.ts';
import { resolveSettingsUpdate } from '../services/settings-service.ts';
import { getSettingsUsecase } from './get-settings-usecase.ts';

export function updateSettingsUsecase(db: Database, input: UpdateSettingsInput): Settings {
  const current = getSettingsUsecase(db);
  const resolved = resolveSettingsUpdate(current, input);

  updateSettingsRow(
    db,
    resolved.defaultProvider,
    resolved.maxConcurrency,
    resolved.updatedAt,
    resolved.rootWorkspace,
    JSON.stringify(resolved.activeHarnesses),
  );

  return resolved;
}
