// Disposable local git repository helper for the deterministic run harness (T09).
// Scenarios mutate a throwaway repo rather than this documentation checkout.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DisposableRepo {
  repoPath: string;
  canonicalPath: string;
  destroy: () => void;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr.trim()}`);
  }
}

// Creates `/tmp/taskaside-test-repo-XXXXXX` (or the system temp dir equivalent),
// runs `git init`, configures a dummy author, and commits a README so scenarios
// have a known starting tree.
export async function createDisposableRepo(): Promise<DisposableRepo> {
  const repoPath = mkdtempSync(join(tmpdir(), 'taskaside-test-repo-'));

  await runGit(repoPath, ['init', '--quiet']);
  await runGit(repoPath, ['config', 'user.email', 'harness@taskaside.local']);
  await runGit(repoPath, ['config', 'user.name', 'TaskAside Harness']);
  writeFileSync(join(repoPath, 'README.md'), '# Disposable harness repo\n');
  await runGit(repoPath, ['add', 'README.md']);
  await runGit(repoPath, ['commit', '--quiet', '-m', 'Initial commit']);

  const canonicalPath = realpathSync(repoPath);

  return {
    repoPath,
    canonicalPath,
    destroy: () => rmSync(repoPath, { recursive: true, force: true }),
  };
}
