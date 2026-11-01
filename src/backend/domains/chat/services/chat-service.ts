// Chat domain rules and helpers (SPECIFICATION.md §2 C-01, TASKS.md T11, LC-04a).
import { DomainError } from '../../../errors.ts';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separatorIndex = decoded.indexOf('|');
  if (separatorIndex === -1) {
    throw new DomainError('VALIDATION_ERROR', 'invalid pagination cursor');
  }
  return { createdAt: decoded.slice(0, separatorIndex), id: decoded.slice(separatorIndex + 1) };
}

export function sanitizePageLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
}
