// Shared domain error type and Hono error handler for the public REST API
// (SPECIFICATION.md §7: typed `{code,message,details?}` bodies, no stack traces).
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ERROR_CODE_HTTP_STATUS, type ErrorCode } from '../../contracts/errors.ts';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function registerErrorHandler(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof DomainError) {
      const status = ERROR_CODE_HTTP_STATUS[err.code] as ContentfulStatusCode;
      const body = {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      };
      return c.json(body, status);
    }
    return c.json({ code: 'VALIDATION_ERROR' as const, message: err.message }, 400);
  });
}
