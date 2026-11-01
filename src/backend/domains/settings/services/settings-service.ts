// Settings domain service (SPECIFICATION.md §3, TASKS.md T15, LC-02a).
import type { Provider, Settings, UpdateSettingsInput } from '../../../../contracts/index.ts';

export function resolveSettingsUpdate(
  current: Settings,
  input: UpdateSettingsInput,
): {
  defaultProvider: Provider;
  maxConcurrency: number;
  rootWorkspace: string | null;
  activeHarnesses: Provider[];
  updatedAt: string;
} {
  const activeHarnesses =
    input.activeHarnesses ?? current.activeHarnesses ?? (['claude', 'codex', 'agy'] as Provider[]);
  let defaultProvider = input.defaultProvider ?? current.defaultProvider;
  if (!activeHarnesses.includes(defaultProvider)) {
    if (activeHarnesses.length > 0) {
      defaultProvider = activeHarnesses[0] as Provider;
    }
  }
  const maxConcurrency = input.maxConcurrency ?? current.maxConcurrency;
  const rootWorkspace =
    input.rootWorkspace !== undefined ? input.rootWorkspace : (current.rootWorkspace ?? null);
  const updatedAt = new Date().toISOString();

  return {
    defaultProvider,
    maxConcurrency,
    rootWorkspace,
    activeHarnesses,
    updatedAt,
  };
}
