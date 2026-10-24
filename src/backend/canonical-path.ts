// Canonical repository path resolution (SPECIFICATION.md §6 E-01, AGENTS.md
// evidence/T04-process-and-repo-identity.md §3). Collapses symlinks, `/tmp` vs
// `/private/tmp`-style aliases, git subdirectories and case-insensitive
// filesystem variants onto one stable key, while preserving the user's
// original display path untouched.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { DomainError } from './api/errors.ts';

function resolveRealPath(displayPath: string): string {
  try {
    return realpathSync(displayPath);
  } catch {
    throw new DomainError('VALIDATION_ERROR', `path does not exist: ${displayPath}`);
  }
}

function assertIsDirectory(resolvedPath: string, displayPath: string): void {
  if (!statSync(resolvedPath).isDirectory()) {
    throw new DomainError('VALIDATION_ERROR', `path is not a directory: ${displayPath}`);
  }
}

function findGitRoot(resolvedPath: string): string | null {
  try {
    const toplevel = execFileSync('git', ['-C', resolvedPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return toplevel.length > 0 ? realpathSync(toplevel) : null;
  } catch {
    return null;
  }
}

function isCaseInsensitiveFs(dir: string): boolean {
  const probeLower = join(dir, '.taskaside-case-probe');
  const probeUpper = join(dir, '.TASKASIDE-CASE-PROBE');
  try {
    writeFileSync(probeLower, 'x');
    return existsSync(probeUpper);
  } catch {
    return false;
  } finally {
    rmSync(probeLower, { force: true });
  }
}

export interface CanonicalPath {
  /** Stable equivalence key: symlink- and case-resolved, git-root-collapsed. */
  canonicalPath: string;
  /** User-facing path exactly as submitted, never altered. */
  displayPath: string;
}

export function canonicalizePath(displayPath: string): CanonicalPath {
  const resolved = resolveRealPath(displayPath);
  assertIsDirectory(resolved, displayPath);

  const gitRoot = findGitRoot(resolved);
  const base = normalize(gitRoot ?? resolved);
  const canonicalPath = isCaseInsensitiveFs(base) ? base.toLowerCase() : base;

  return { canonicalPath, displayPath };
}
