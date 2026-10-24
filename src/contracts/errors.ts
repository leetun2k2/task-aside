// Typed error codes and standard error response shape, shared across all processes.
import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'STALE_GENERATION',
  'SEQUENCE_CONFLICT',
  'REQUEST_ALREADY_RESOLVED',
  'LOCK_HELD',
  'CAPACITY_EXCEEDED',
  'RUN_UNCERTAIN',
  'VERIFIED_STOP_REQUIRED',
  'CHILD_LIMIT_EXCEEDED',
  'INVALID_TRANSITION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_CODE_HTTP_STATUS: Record<ErrorCode, number> = {
  STALE_GENERATION: 409,
  SEQUENCE_CONFLICT: 409,
  REQUEST_ALREADY_RESOLVED: 409,
  LOCK_HELD: 409,
  CAPACITY_EXCEEDED: 409,
  RUN_UNCERTAIN: 409,
  VERIFIED_STOP_REQUIRED: 400,
  CHILD_LIMIT_EXCEEDED: 400,
  INVALID_TRANSITION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
};

export const ErrorResponseSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
