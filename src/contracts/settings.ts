// Settings domain schemas and diagnostics contracts (SPECIFICATION.md §3, TASKS.md T15).
import { z } from 'zod';
import { ProviderSchema } from './task.ts';

export const SettingsSchema = z.object({
  defaultProvider: ProviderSchema,
  maxConcurrency: z.number().int().min(1).max(10),
  updatedAt: z.string(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const UpdateSettingsInputSchema = z
  .object({
    defaultProvider: ProviderSchema.optional(),
    maxConcurrency: z.number().int().min(1).max(10).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one setting field must be provided',
  });
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInputSchema>;

export const DiagnosticsSchema = z.object({
  service: z.literal('backend'),
  version: z.string(),
  uptimeSeconds: z.number(),
  tasksCount: z.number().int(),
  runsCount: z.number().int(),
  activeRunsCount: z.number().int(),
  connectedClients: z.number().int(),
  dbPath: z.string(),
});
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;

export const SettingsResponseSchema = SettingsSchema.extend({
  diagnostics: DiagnosticsSchema,
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
