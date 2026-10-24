// MCP token and pairing management (SPECIFICATION.md §4, §8.1; ARCHITECTURE.md §9; T14).
// Manages short-lived run-scoped managed tokens and paired external tokens with tool scopes.
import type { Database } from 'bun:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import type { McpToolName } from '../../contracts/mcp.ts';
import { DomainError } from '../api/errors.ts';
import type { RunRow } from '../domains/task/runs.ts';
import { type TaskRecord, getTaskById } from '../domains/task/tasks.ts';

export type McpRole = 'mcp-managed' | 'mcp-external';

export interface ManagedMcpAuthContext {
  role: 'mcp-managed';
  tokenId: string;
  runId: string;
  taskId: string;
  task: TaskRecord;
  run: RunRow;
  allowedTools: Set<McpToolName>;
}

export interface ExternalMcpAuthContext {
  role: 'mcp-external';
  tokenId: string;
  clientName: string;
  allowedTools: Set<McpToolName>;
  allowedRepoIds?: Set<string>;
  allowedTaskIds?: Set<string>;
}

export type McpAuthContext = ManagedMcpAuthContext | ExternalMcpAuthContext;

const ALL_MANAGED_TOOLS: McpToolName[] = [
  'list_tasks',
  'get_task',
  'create_task',
  'get_messages',
  'post_message',
  'request_input',
  'yield_task',
];

interface McpTokenRow {
  id: string;
  token: string;
  role: McpRole;
  client_name: string;
  run_id: string | null;
  task_id: string | null;
  allowed_tools: string;
  allowed_repo_ids: string | null;
  allowed_task_ids: string | null;
  expires_at: string | null;
  revoked: number;
  created_at: string;
}

interface McpPairingRow {
  code: string;
  client_name: string | null;
  expires_at: string;
  created_at: string;
}

export function mintManagedMcpToken(
  db: Database,
  runId: string,
  taskId: string,
): { id: string; token: string; runId: string; taskId: string } {
  const task = getTaskById(db, taskId);
  if (!task) {
    throw new DomainError('NOT_FOUND', `task not found: ${taskId}`);
  }

  const runRow = db.query('SELECT id, status FROM runs WHERE id = ?').get(runId) as {
    id: string;
    status: string;
  } | null;
  if (!runRow) {
    throw new DomainError('NOT_FOUND', `run not found: ${runId}`);
  }

  const id = randomUUID();
  const token = `mcp-m-${randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();

  db.query(
    `INSERT INTO mcp_tokens
      (id, token, role, client_name, run_id, task_id, allowed_tools,
       allowed_repo_ids, allowed_task_ids, expires_at, revoked, created_at)
     VALUES (?, ?, 'mcp-managed', 'managed-agent', ?, ?, ?, NULL, NULL, NULL, 0, ?)`,
  ).run(id, token, runId, taskId, JSON.stringify(ALL_MANAGED_TOOLS), now);

  return { id, token, runId, taskId };
}

export function createPairingCode(
  db: Database,
  clientName?: string,
): { code: string; expiresAt: string } {
  const code = `PAIR-${randomBytes(3).toString('hex').toUpperCase()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // 10 minutes

  db.query(
    'INSERT INTO mcp_pairings (code, client_name, expires_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(code, clientName ?? null, expiresAt, now.toISOString());

  return { code, expiresAt };
}

export interface ApprovePairingOptions {
  clientName: string;
  allowedTools: McpToolName[];
  allowedRepoIds?: string[];
  allowedTaskIds?: string[];
}

export function approvePairing(
  db: Database,
  code: string,
  options: ApprovePairingOptions,
): { id: string; token: string; clientName: string; allowedTools: McpToolName[] } {
  const row = db
    .query('SELECT * FROM mcp_pairings WHERE code = ?')
    .get(code) as McpPairingRow | null;
  if (!row) {
    throw new DomainError('UNAUTHORIZED', 'invalid pairing code');
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.query('DELETE FROM mcp_pairings WHERE code = ?').run(code);
    throw new DomainError('UNAUTHORIZED', 'pairing code has expired');
  }

  // Filter out `yield_task` for external tokens (managed-only)
  const allowedTools = options.allowedTools.filter((t) => t !== 'yield_task');

  const id = randomUUID();
  const token = `mcp-e-${randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();

  const apply = db.transaction(() => {
    db.query('DELETE FROM mcp_pairings WHERE code = ?').run(code);
    db.query(
      `INSERT INTO mcp_tokens
        (id, token, role, client_name, run_id, task_id, allowed_tools,
         allowed_repo_ids, allowed_task_ids, expires_at, revoked, created_at)
       VALUES (?, ?, 'mcp-external', ?, NULL, NULL, ?, ?, ?, NULL, 0, ?)`,
    ).run(
      id,
      token,
      options.clientName,
      JSON.stringify(allowedTools),
      options.allowedRepoIds ? JSON.stringify(options.allowedRepoIds) : null,
      options.allowedTaskIds ? JSON.stringify(options.allowedTaskIds) : null,
      now,
    );
  });
  apply();

  return { id, token, clientName: options.clientName, allowedTools };
}

export function revokeMcpToken(db: Database, idOrToken: string): void {
  db.query('UPDATE mcp_tokens SET revoked = 1 WHERE id = ? OR token = ?').run(idOrToken, idOrToken);
}

export interface ExternalMcpTokenRecord {
  id: string;
  clientName: string;
  allowedTools: McpToolName[];
  allowedRepoIds?: string[];
  allowedTaskIds?: string[];
  revoked: boolean;
  createdAt: string;
}

export function listExternalMcpTokens(db: Database): ExternalMcpTokenRecord[] {
  const rows = db
    .query('SELECT * FROM mcp_tokens WHERE role = ? ORDER BY created_at DESC')
    .all('mcp-external') as McpTokenRow[];
  return rows.map((r) => ({
    id: r.id,
    clientName: r.client_name,
    allowedTools: JSON.parse(r.allowed_tools) as McpToolName[],
    allowedRepoIds: r.allowed_repo_ids ? (JSON.parse(r.allowed_repo_ids) as string[]) : undefined,
    allowedTaskIds: r.allowed_task_ids ? (JSON.parse(r.allowed_task_ids) as string[]) : undefined,
    revoked: r.revoked === 1,
    createdAt: r.created_at,
  }));
}

export function validateMcpToken(db: Database, token: string): McpAuthContext | null {
  const row = db.query('SELECT * FROM mcp_tokens WHERE token = ?').get(token) as McpTokenRow | null;
  if (!row) {
    return null;
  }

  if (row.revoked === 1) {
    throw new DomainError('UNAUTHORIZED', 'token has been revoked');
  }

  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new DomainError('UNAUTHORIZED', 'token has expired');
  }

  if (row.role === 'mcp-managed') {
    if (!row.run_id || !row.task_id) {
      throw new DomainError('UNAUTHORIZED', 'invalid managed token record');
    }

    const run = db.query('SELECT * FROM runs WHERE id = ?').get(row.run_id) as RunRow | null;
    if (!run || run.ended_at !== null || (run.status !== 'running' && run.status !== 'hitl')) {
      throw new DomainError('UNAUTHORIZED', 'managed token expired: run has ended');
    }

    const task = getTaskById(db, row.task_id);
    if (!task) {
      throw new DomainError('NOT_FOUND', `task not found: ${row.task_id}`);
    }

    return {
      role: 'mcp-managed',
      tokenId: row.id,
      runId: row.run_id,
      taskId: row.task_id,
      task,
      run,
      allowedTools: new Set(JSON.parse(row.allowed_tools) as McpToolName[]),
    };
  }

  return {
    role: 'mcp-external',
    tokenId: row.id,
    clientName: row.client_name,
    allowedTools: new Set(JSON.parse(row.allowed_tools) as McpToolName[]),
    allowedRepoIds: row.allowed_repo_ids ? new Set(JSON.parse(row.allowed_repo_ids)) : undefined,
    allowedTaskIds: row.allowed_task_ids ? new Set(JSON.parse(row.allowed_task_ids)) : undefined,
  };
}
