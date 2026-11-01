// Settings domain compatibility exports (SPECIFICATION.md §3, TASKS.md T15, LC-02a).
import type { Database } from 'bun:sqlite';
import type { Diagnostics, Settings, UpdateSettingsInput } from '../../../contracts/index.ts';
import { getDiagnosticsUsecase } from './usecases/get-diagnostics-usecase.ts';
import { getSettingsUsecase } from './usecases/get-settings-usecase.ts';
import { updateSettingsUsecase } from './usecases/update-settings-usecase.ts';

export function getSettings(db: Database): Settings {
  return getSettingsUsecase(db);
}

export function updateSettings(db: Database, input: UpdateSettingsInput): Settings {
  return updateSettingsUsecase(db, input);
}

export function getDiagnostics(
  db: Database,
  options: { connectedClients?: number } = {},
): Diagnostics {
  return getDiagnosticsUsecase(db, options);
}
