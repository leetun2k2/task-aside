// Crash-safe launch identity journal (LC-05c-p). Stores process metadata only
// (pid, payload hash, timestamps) — never task truth, never the instruction
// text itself, never SQLite. A plain JSON file is enough: one adapter
// process, low volume, synchronous reads/writes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Provider } from '../../contracts/index.ts';
import { getLaunchJournalPath } from '../../supervisor/paths.ts';

export interface LaunchRecord {
  launchId: string;
  runId: string;
  provider: Provider;
  payloadHash: string;
  pgid: number | null;
  startedAt: string;
  status: 'active' | 'stopped';
}

export interface LaunchPayload {
  provider: Provider;
  cwd: string;
  writeRoots: string[];
  purpose: 'intake' | 'implementation';
  instructionLength: number;
}

export function computePayloadHash(payload: LaunchPayload): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      provider: payload.provider,
      cwd: payload.cwd,
      writeRoots: [...payload.writeRoots].sort(),
      purpose: payload.purpose,
      instructionLength: payload.instructionLength,
    }),
  );
  return hash.digest('hex');
}

export function loadJournal(path: string = getLaunchJournalPath()): LaunchRecord[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as LaunchRecord[]) : [];
  } catch {
    return [];
  }
}

function saveJournal(records: LaunchRecord[], path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(records));
  } catch {
    // Best-effort durability: a failed write means a crash-restart can't see
    // this launch, which is no worse than before this journal existed.
  }
}

export function recordLaunchStarted(
  record: LaunchRecord,
  path: string = getLaunchJournalPath(),
): void {
  const records = loadJournal(path).filter((r) => r.runId !== record.runId);
  records.push(record);
  saveJournal(records, path);
}

export function recordLaunchStopped(runId: string, path: string = getLaunchJournalPath()): void {
  const records = loadJournal(path);
  const idx = records.findIndex((r) => r.runId === runId);
  if (idx === -1) {
    return;
  }
  records[idx] = { ...records[idx], status: 'stopped' };
  saveJournal(records, path);
}

export function getActiveLaunch(
  runId: string,
  path: string = getLaunchJournalPath(),
): LaunchRecord | undefined {
  return loadJournal(path).find((r) => r.runId === runId && r.status === 'active');
}
