// Role credentials and internal-route authentication (ARCHITECTURE.md §3.1,
// SPECIFICATION.md §8.1). Only backend/agent-adapter mount `internalAuth`; the
// browser `auth.token` must never be accepted on `/internal/v1/*`.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Context, Next } from 'hono';
import { getAuthTokenPath, getInternalTokenPath } from './paths.ts';

export type ServiceRole =
  'supervisor' | 'engine' | 'adapter' | 'browser' | 'mcp-managed' | 'mcp-external';

const INTERNAL_ROLES: ReadonlySet<ServiceRole> = new Set(['supervisor', 'engine', 'adapter']);

function generateToken(): string {
  // 256-bit random token, hex-encoded.
  return randomBytes(32).toString('hex');
}

function ensureToken(path: string): string {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }
  const token = generateToken();
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function ensureAuthToken(): string {
  return ensureToken(getAuthTokenPath());
}

export function ensureInternalToken(): string {
  return ensureToken(getInternalTokenPath());
}

function isInternalRole(value: string | undefined): value is ServiceRole {
  return value !== undefined && INTERNAL_ROLES.has(value as ServiceRole);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function unauthorized(c: Context, message: string): Response {
  return c.json({ code: 'UNAUTHORIZED', message }, 401);
}

function forbidden(c: Context, message: string): Response {
  return c.json({ code: 'FORBIDDEN', message }, 403);
}

// Mounted on `/internal/v1/*` by backend and agent-adapter. Requires the
// supervisor-provisioned `internal.token` plus an `X-TaskAside-Role` header
// drawn from the three internal roles and allowed for the specific route.
export function internalAuth(allowedRoles: ServiceRole[], options: { token?: string } = {}) {
  const allowed = new Set(allowedRoles);

  return async (c: Context, next: Next) => {
    let expectedToken = options.token ?? process.env.TASKASIDE_INTERNAL_TOKEN;
    if (!expectedToken) {
      try {
        expectedToken = ensureInternalToken();
      } catch {
        expectedToken = '';
      }
    }
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined;

    if (!expectedToken || !token || !safeEqual(token, expectedToken)) {
      return unauthorized(c, 'missing or invalid internal token');
    }

    const role = c.req.header('X-TaskAside-Role');
    if (!isInternalRole(role)) {
      return forbidden(c, 'missing or invalid X-TaskAside-Role header');
    }

    if (!allowed.has(role)) {
      return forbidden(c, `role '${role}' is not permitted for this route`);
    }

    await next();
  };
}

// Mounted on browser/public routes by backend. Validates the supervisor-provisioned
// `auth.token` passed via `Authorization: Bearer <token>` or `?token=<token>`.
// Explicitly rejects `internal.token` with 403 (SPECIFICATION.md §8.1:
// "Browser tokens cannot authorize internal routes and vice versa").
export function browserAuth(options: { token?: string } = {}) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');
    const headerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    const queryToken = c.req.query('token');
    const token = headerToken ?? queryToken;

    if (!token) {
      return unauthorized(c, 'missing browser authorization token');
    }

    const internalToken = process.env.TASKASIDE_INTERNAL_TOKEN;
    if (internalToken && safeEqual(token, internalToken)) {
      return forbidden(c, 'internal token cannot be used on browser routes');
    }

    let expectedToken = options.token ?? process.env.TASKASIDE_AUTH_TOKEN;
    if (!expectedToken) {
      try {
        expectedToken = ensureAuthToken();
      } catch {
        expectedToken = '';
      }
    }

    if (!expectedToken || !safeEqual(token, expectedToken)) {
      return unauthorized(c, 'invalid browser authorization token');
    }

    await next();
  };
}
