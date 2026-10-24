// Adapter domain error type and Hono error handler (SPECIFICATION.md §7).
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ERROR_CODE_HTTP_STATUS, type ErrorCode } from '../contracts/errors.ts';

export class AdapterError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends AdapterError {
  constructor(message: string) {
    super('NOT_FOUND', message);
  }
}

export class StaleGenerationError extends AdapterError {
  constructor(message: string) {
    super('STALE_GENERATION', message);
  }
}

export class RequestAlreadyResolvedError extends AdapterError {
  constructor(message: string) {
    super('REQUEST_ALREADY_RESOLVED', message);
  }
}

export class ValidationError extends AdapterError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message);
  }
}

export function registerAdapterErrorHandler(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof AdapterError) {
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
