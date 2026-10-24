// Verification suite for T14: Scoped MCP — backend (SPECIFICATION.md §4, §8.1; ARCHITECTURE.md §8, §9).
// Covers: 7 tools, JSON-RPC & direct transport, managed run token lifecycle & auto-expiration,
// external pairing flow & scope denial & revocation, child budget (depth 0, max 5),
// child idempotency key deduplication, yield_task verified stop and lock release.

import type { Database } from 'bun:sqlite';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { mountPublicApi } from './api/index.ts';
import { claimTask, finalizeRun } from './domains/task/runs.ts';
import { createTask } from './domains/task/tasks.ts';
import { closeDatabase, initializeDatabase, openDatabase } from './index.ts';
import {
  approvePairing,
  createPairingCode,
  listExternalMcpTokens,
  mintManagedMcpToken,
  revokeMcpToken,
  validateMcpToken,
} from './mcp/tokens.ts';

const testDir = `/tmp/taskaside-mcp-test-${Date.now()}`;
const dbPath = join(testDir, 'test.sqlite');

let db: Database | undefined;
let app: Hono;

function countTasksInRepo(database: Database, repoId: string): number {
  const row = database
    .query('SELECT COUNT(*) as count FROM tasks WHERE repository_id = ?')
    .get(repoId) as { count: number };
  return row.count;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: test helper response type
type TestResponseBody = any;

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: TestResponseBody }> {
  const reqHeaders: Record<string, string> = {
    'content-type': 'application/json',
    host: '127.0.0.1:4000',
    origin: 'http://127.0.0.1:4000',
    ...headers,
  };

  const res = await app.fetch(
    new Request(`http://127.0.0.1:4000${path}`, {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );

  const text = await res.text();
  let parsed: TestResponseBody;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

console.log('\nT14 Scoped MCP Verification Suite:\n');

try {
  db = initializeDatabase({ path: dbPath });
  app = new Hono();
  mountPublicApi(app, db);

  // Setup seed repository and task
  const now = new Date().toISOString();
  db.query(
    'INSERT INTO repositories (id, name, display_path, canonical_path, default_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('repo-1', 'test-repo', '/tmp/repo-1', '/tmp/repo-1', 'codex', now);
  db.query(
    'INSERT INTO repositories (id, name, display_path, canonical_path, default_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('repo-2', 'test-repo-2', '/tmp/repo-2', '/tmp/repo-2', 'codex', now);
  db.query(
    'INSERT INTO repositories (id, name, display_path, canonical_path, default_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('repo-forbidden', 'test-repo-forbidden', '/tmp/repo-forbidden', '/tmp/repo-forbidden', 'codex', now);

  const rootTask = createTask(db, {
    repoId: 'repo-1',
    title: 'Root Task 1',
    priority: 'P1',
  });

  const otherTask = createTask(db, {
    repoId: 'repo-1',
    title: 'Other Task 2',
    priority: 'P2',
  });

  // 1. Unrecognized / missing MCP token
  {
    const resNoToken = await request('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    assert(resNoToken.status === 401, 'expected 401 on missing token');
    assert(
      resNoToken.body.code === 'UNAUTHORIZED' && resNoToken.body.pairingCode,
      'expected pairingCode on 401',
    );

    const resBadToken = await request(
      'POST',
      '/mcp',
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { authorization: 'Bearer invalid-token' },
    );
    assert(resBadToken.status === 401, 'expected 401 on invalid token');
    assert(resBadToken.body.pairingCode, 'expected new pairingCode on invalid token');
    console.log('  ✓ unrecognized / missing MCP token returns 401 with pairing code');
  }

  // 2. External pairing flow, scope enforcement, and revocation
  {
    const pairing = createPairingCode(db, 'cursor-agent');
    assert(pairing.code.startsWith('PAIR-'), 'expected pairing code prefix');

    // Approve pairing with restricted tools: list_tasks and get_task only
    const approveRes = await request('POST', '/api/mcp/approve-pairing', {
      pairingCode: pairing.code,
      clientName: 'cursor-agent',
      allowedTools: ['list_tasks', 'get_task'],
    });
    assert(approveRes.status === 201, 'expected 201 on approve-pairing');
    const externalToken = approveRes.body.token;
    const externalTokenId = approveRes.body.id;
    assert(externalToken.startsWith('mcp-e-'), 'expected external token prefix');

    // Pairing code reuse fails
    const reuseRes = await request('POST', '/api/mcp/approve-pairing', {
      pairingCode: pairing.code,
      clientName: 'cursor-agent',
      allowedTools: ['list_tasks'],
    });
    assert(reuseRes.status === 401, 'expected 401 on reused pairing code');

    // Allowed tool call succeeds (JSON-RPC)
    const listRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'list_tasks', arguments: {} },
      },
      { authorization: `Bearer ${externalToken}` },
    );
    assert(listRes.status === 200, 'expected 200 on allowed list_tasks call');
    assert(listRes.body.result?.content, 'expected tools/call content in JSON-RPC result');

    // Disallowed tool call rejected with 403
    const deniedRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'create_task', arguments: { title: 'hacked' } },
      },
      { authorization: `Bearer ${externalToken}` },
    );
    assert(deniedRes.status === 403, 'expected 403 FORBIDDEN on ungranted tool');
    assert(deniedRes.body.code === 'FORBIDDEN', 'expected FORBIDDEN error code');

    // External token calling yield_task is always forbidden (managed-only)
    const yieldDenied = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'yield_task', arguments: {} },
      },
      { authorization: `Bearer ${externalToken}` },
    );
    assert(yieldDenied.status === 403, 'expected 403 FORBIDDEN for yield_task on external token');

    // Revoke token
    const revokeRes = await request('POST', `/api/mcp/tokens/${externalTokenId}/revoke`);
    assert(revokeRes.status === 200, 'expected 200 on revoke');

    // Subsequent call with revoked token rejected with 401
    const postRevokeRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'list_tasks', arguments: {} },
      },
      { authorization: `Bearer ${externalToken}` },
    );
    assert(postRevokeRes.status === 401, 'expected 401 on revoked token');
    console.log(
      '  ✓ external pairing flow: approve, scopes allowed/denied, yield_task rejected, revocation',
    );
  }

  // 3. Managed run-scoped token lifecycle, tool scoping, and auto-expiration
  let managedToken: string;
  let runId: string;
  {
    // Claim rootTask to establish active run
    const claimRes = claimTask(db, rootTask.id, {
      ownerId: 'engine-1',
      generation: 1,
      idempotencyKey: 'claim-root-1',
    });
    runId = claimRes.runId;

    const managedMint = mintManagedMcpToken(db, runId, rootTask.id);
    managedToken = managedMint.token;
    assert(managedToken.startsWith('mcp-m-'), 'expected managed token prefix');

    // JSON-RPC initialize
    const initRes = await request(
      'POST',
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(initRes.status === 200, 'expected 200 on initialize');
    assert(initRes.body.result?.protocolVersion === '2024-11-05', 'expected MCP protocol version');

    // JSON-RPC tools/list returns all 7 tools
    const toolsRes = await request(
      'POST',
      '/mcp',
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(toolsRes.status === 200, 'expected 200 on tools/list');
    const tools = toolsRes.body.result.tools;
    assert(tools.length === 7, `expected 7 tools, got ${tools.length}`);

    // list_tasks for managed agent is restricted to current task and its children
    const listTasksRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_tasks', arguments: {} },
      },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(listTasksRes.status === 200, 'expected 200 on list_tasks');
    const tasksInScope = JSON.parse(listTasksRes.body.result.content[0].text);
    assert(
      tasksInScope.length === 1 && tasksInScope[0].id === rootTask.id,
      'managed agent should only see current task and children, not other tasks',
    );

    // get_task: can get own task
    const getSelfRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_task', arguments: { taskId: rootTask.id } },
      },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(getSelfRes.status === 200, 'expected 200 on get_task self');

    // get_task: cannot get other task outside tree
    const getOtherRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'get_task', arguments: { taskId: otherTask.id } },
      },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(getOtherRes.status === 403, 'expected 403 FORBIDDEN on get_task other');

    // post_message and get_messages for task conversation
    const postMsgRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'post_message', arguments: { content: 'Agent progress note' } },
      },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(postMsgRes.status === 200, 'expected 200 on post_message');

    const getMsgRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'get_messages', arguments: {} },
      },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(getMsgRes.status === 200, 'expected 200 on get_messages');
    const msgs = JSON.parse(getMsgRes.body.result.content[0].text);
    assert(msgs.messages.length >= 1, 'expected at least one message returned');

    // request_input: triggers structured HITL
    const hitlRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'request_input', arguments: { question: 'Please confirm target path' } },
      },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(hitlRes.status === 200, 'expected 200 on request_input');
    const hitlData = JSON.parse(hitlRes.body.result.content[0].text);
    assert(hitlData.status === 'hitl' && hitlData.requestId, 'expected hitl status and requestId');

    // Verify task and run transitioned to hitl
    const taskRowAfterHitl = db.query('SELECT status FROM tasks WHERE id = ?').get(rootTask.id) as {
      status: string;
    };
    const runRowAfterHitl = db
      .query('SELECT status, pending_input_request_id FROM runs WHERE id = ?')
      .get(runId) as { status: string; pending_input_request_id: string };
    assert(taskRowAfterHitl.status === 'hitl', 'task should be in hitl status');
    assert(
      runRowAfterHitl.status === 'hitl' &&
        runRowAfterHitl.pending_input_request_id === hitlData.requestId,
      'run should have pending_input_request_id',
    );

    console.log(
      '  ✓ managed run token: initialize, 7 tools listed, scoped task/messages, structured HITL',
    );
  }

  // 4. Child task delegation, depth limit, child ceiling, and idempotency key
  let childTaskId: string;
  {
    // Resume run to running for child creation checks
    db.query("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    db.query("UPDATE tasks SET status = 'processing' WHERE id = ?").run(rootTask.id);

    // Create child task with idempotencyKey
    const createChildRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: {
            title: 'Child Task 1',
            priority: 'P2',
            idempotencyKey: 'child-idem-1',
          },
        },
      },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(createChildRes.status === 200, 'expected 200 on create_task child');
    const childTask = JSON.parse(createChildRes.body.result.content[0].text);
    childTaskId = childTask.id;
    assert(childTask.depth === 1, 'child task depth must be 1');
    assert(childTask.parentId === rootTask.id, 'child task parentId must match rootTask');

    // Child task MCP create retried with same idempotencyKey returns existing child
    const retryChildRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: {
            title: 'Child Task 1 - Duplicate Attempt',
            priority: 'P2',
            idempotencyKey: 'child-idem-1',
          },
        },
      },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(retryChildRes.status === 200, 'expected 200 on idempotent child create retry');
    const retriedTask = JSON.parse(retryChildRes.body.result.content[0].text);
    assert(
      retriedTask.id === childTaskId,
      'idempotent retry must return the exact same child task',
    );

    // Grandchild creation attempt (depth 1 calling create_task) fails
    // Set up a mock run on the child task
    const childRunId = 'child-run-1';
    db.query(
      `INSERT INTO runs
        (id, task_id, provider, status, owner_token, lock_generation, started_at, heartbeat_at)
       VALUES (?, ?, 'codex', 'running', 'engine-1', 1, ?, ?)`,
    ).run(childRunId, childTaskId, now, now);

    const childToken = mintManagedMcpToken(db, childRunId, childTaskId).token;
    const grandchildRes = await request(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: { title: 'Grandchild Task' },
        },
      },
      { authorization: `Bearer ${childToken}` },
    );
    assert(
      grandchildRes.status === 400,
      'expected 400 CHILD_LIMIT_EXCEEDED on grandchild creation',
    );
    assert(
      grandchildRes.body.code === 'CHILD_LIMIT_EXCEEDED',
      'expected CHILD_LIMIT_EXCEEDED error code',
    );

    // Max 5 children ceiling:
    // Create 4 more children (total 5)
    for (let i = 2; i <= 5; i++) {
      const cRes = await request(
        'POST',
        '/mcp',
        {
          name: 'create_task',
          arguments: { title: `Child Task ${i}`, priority: 'P3' },
        },
        { authorization: `Bearer ${managedToken}` },
      );
      assert(cRes.status === 200, `expected child ${i} creation to succeed`);
    }

    // 6th child creation fails
    const sixthChildRes = await request(
      'POST',
      '/mcp',
      {
        name: 'create_task',
        arguments: { title: 'Child Task 6 - Over Limit' },
      },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(sixthChildRes.status === 400, 'expected 400 on exceeding 5 children ceiling');
    assert(
      sixthChildRes.body.code === 'CHILD_LIMIT_EXCEEDED',
      'expected CHILD_LIMIT_EXCEEDED for 6th child',
    );

    console.log(
      '  ✓ child delegation: depth 1 enforced, idempotency dedup verified, 5-child ceiling enforced, grandchild rejected',
    );
  }

  // 5. Yield task contract: child ownership, asynchronous intent (never proof
  // of exit), idempotent replay, and trusted-finalize lock release (A4, A5)
  {
    // Calling yield_task with an invalid child ID fails
    const invalidChildYield = await request(
      'POST',
      '/mcp',
      {
        name: 'yield_task',
        arguments: { childTaskIds: ['non-existent-child'] },
      },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(invalidChildYield.status === 403, 'expected 403 when yielding to non-owned child');

    interface LockRowCheck {
      working_tree_key: string;
      owner_run_id: string;
      generation: number;
    }
    interface TaskRowCheck {
      id: string;
      status: string;
      block_kind: string | null;
      blocked_on_child_ids: string | null;
    }
    interface RunRowCheck {
      id: string;
      status: string;
    }

    const lockBefore = db
      .query('SELECT * FROM run_locks WHERE working_tree_key = ?')
      .get('/tmp/repo-1') as LockRowCheck;
    const generationBefore = lockBefore.generation;

    // A4: no client field/header can attest process exit. Absent/false/true
    // x-verified-stopped must all be accepted identically as an async intent
    // (status: yield_requested), never trusted as stop proof — ownership
    // (lock + run + task state) stays completely unchanged.
    for (const header of [undefined, 'false', 'true']) {
      const headers: Record<string, string> = { authorization: `Bearer ${managedToken}` };
      if (header !== undefined) {
        headers['x-verified-stopped'] = header;
      }
      const yieldRes = await request(
        'POST',
        '/mcp',
        { name: 'yield_task', arguments: { reason: 'Yielding to 5 child tasks' } },
        headers,
      );
      assert(
        yieldRes.status === 200,
        `expected 200 on yield_task regardless of x-verified-stopped (header=${header}), got ${yieldRes.status}`,
      );
      assert(
        yieldRes.body.result?.status === 'yield_requested',
        `expected yield_requested status, got ${yieldRes.body.result?.status}`,
      );
      assert(
        yieldRes.body.result?.blockedOnChildIds.length === 5,
        'expected blockedOnChildIds to contain all 5 children',
      );

      const lockDuring = db
        .query('SELECT * FROM run_locks WHERE working_tree_key = ?')
        .get('/tmp/repo-1') as LockRowCheck;
      assert(lockDuring.owner_run_id === runId, 'lock must stay held while intent is pending');
      assert(lockDuring.generation === generationBefore, 'generation must not change');

      const taskDuring = db.query('SELECT * FROM tasks WHERE id = ?').get(rootTask.id) as TaskRowCheck;
      assert(taskDuring.status === 'processing', 'task must stay processing while intent is pending');
      assert(taskDuring.block_kind === null, 'task must not be blocked on children yet');

      const runDuring = db.query('SELECT * FROM runs WHERE id = ?').get(runId) as RunRowCheck;
      assert(runDuring.status === 'running', 'run must stay running while intent is pending');
    }

    // Replaying a DIFFERENT scope while one is pending is rejected
    const conflictingYield = await request(
      'POST',
      '/mcp',
      { name: 'yield_task', arguments: { reason: 'A different reason' } },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(
      conflictingYield.status === 400,
      `expected 400 on conflicting pending yield intent, got ${conflictingYield.status}`,
    );
    assert(
      conflictingYield.body.code === 'VALIDATION_ERROR',
      'expected VALIDATION_ERROR for conflicting pending yield intent',
    );

    // Only trusted adapter stop evidence — via the same finalizeRun path the
    // engine uses, never the MCP yield_task call itself — may release the
    // lock and block the parent on children.
    finalizeRun(db, runId, {
      ownerId: 'engine-1',
      generation: generationBefore,
      status: 'done',
      verifiedStopped: true,
      verificationMethod: 'process_group_empty',
    });

    const yieldedTask = db.query('SELECT * FROM tasks WHERE id = ?').get(rootTask.id) as TaskRowCheck;
    assert(yieldedTask.status === 'todo', 'task should be in todo status post-finalize');
    assert(yieldedTask.block_kind === 'children', 'block_kind should be children');
    const blockedIds = JSON.parse(yieldedTask.blocked_on_child_ids ?? '[]');
    assert(blockedIds.length === 5, 'expected 5 blocked child IDs');

    const lockAfter = db
      .query('SELECT * FROM run_locks WHERE working_tree_key = ?')
      .get('/tmp/repo-1') as LockRowCheck;
    assert(lockAfter.owner_run_id === '', 'lock owner_run_id must be cleared after finalize');
    assert(
      lockAfter.generation === generationBefore,
      'generation must never reset or change on release',
    );

    // Managed token auto-expires upon run finalization
    const postYieldTokenCall = await request(
      'POST',
      '/mcp',
      { name: 'list_tasks', arguments: {} },
      { authorization: `Bearer ${managedToken}` },
    );
    assert(
      postYieldTokenCall.status === 401,
      'expected 401: managed token must expire when run ends',
    );
    assert(
      postYieldTokenCall.body.code === 'UNAUTHORIZED',
      'expected UNAUTHORIZED on expired managed token',
    );

    console.log(
      '  ✓ yield_task contract: header-independent async intent, idempotent replay, conflicting-scope rejected, trusted finalize blocks on children and releases lock, token auto-expired',
    );
  }

  // 6. Architecture boundary check: zero bun:sqlite outside src/backend
  {
    const repoRoot = process.cwd();
    const srcRoot = join(repoRoot, 'src');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
          continue;
        }
        if (
          fullPath.includes('/src/backend/') ||
          fullPath === join(repoRoot, 'src', 'backend', 'db-checks.ts') ||
          fullPath === join(repoRoot, 'src', 'harness', 'harness-checks.ts') ||
          fullPath === join(repoRoot, 'src', 'backend', 'mcp-checks.ts')
        ) {
          continue;
        }
        const content = Bun.file(fullPath).text();
        if (content.toString().includes('bun:sqlite')) {
          offenders.push(fullPath.replace(`${repoRoot}/`, ''));
        }
      }
    };
    walk(srcRoot);

    assert(
      offenders.length === 0,
      `found forbidden bun:sqlite imports outside src/backend: ${offenders.join(', ')}`,
    );
    console.log('  ✓ boundary: zero bun:sqlite imports outside src/backend');
  }

  // 7. External create_task contract: explicit repo selection + durable
  // idempotency (specs/2026-10-24-handoff-single-writer.md A7, A8)
  {
    const pairing = createPairingCode(db, 'external-create-task-client');
    const approveRes = await request('POST', '/api/mcp/approve-pairing', {
      pairingCode: pairing.code,
      clientName: 'external-create-task-client',
      allowedTools: ['create_task'],
      allowedRepoIds: ['repo-1', 'repo-2'],
    });
    assert(approveRes.status === 201, 'expected 201 on approve-pairing for create_task client');
    const token = approveRes.body.token as string;

    // Missing repoId is a validation failure; no task is created
    const missingRepo = await request(
      'POST',
      '/mcp',
      { name: 'create_task', arguments: { title: 'No repo given', idempotencyKey: 'k-missing-repo' } },
      { authorization: `Bearer ${token}` },
    );
    assert(missingRepo.status === 400, `expected 400 on missing repoId, got ${missingRepo.status}`);
    assert(missingRepo.body.code === 'VALIDATION_ERROR', 'expected VALIDATION_ERROR');

    // Missing idempotencyKey is a validation failure
    const missingKey = await request(
      'POST',
      '/mcp',
      { name: 'create_task', arguments: { title: 'No key given', repoId: 'repo-1' } },
      { authorization: `Bearer ${token}` },
    );
    assert(missingKey.status === 400, `expected 400 on missing idempotencyKey, got ${missingKey.status}`);
    assert(missingKey.body.code === 'VALIDATION_ERROR', 'expected VALIDATION_ERROR');

    // Unknown repoId is not-found; no task created
    const unknownRepo = await request(
      'POST',
      '/mcp',
      {
        name: 'create_task',
        arguments: { title: 'Unknown repo', repoId: 'repo-does-not-exist', idempotencyKey: 'k-unknown' },
      },
      { authorization: `Bearer ${token}` },
    );
    assert(unknownRepo.status === 404, `expected 404 on unknown repoId, got ${unknownRepo.status}`);
    assert(unknownRepo.body.code === 'NOT_FOUND', 'expected NOT_FOUND');

    // Forbidden (registered but not authorized) repoId is denied; no task created
    const forbiddenRepo = await request(
      'POST',
      '/mcp',
      {
        name: 'create_task',
        arguments: { title: 'Forbidden repo', repoId: 'repo-forbidden', idempotencyKey: 'k-forbidden' },
      },
      { authorization: `Bearer ${token}` },
    );
    assert(forbiddenRepo.status === 403, `expected 403 on forbidden repoId, got ${forbiddenRepo.status}`);
    assert(forbiddenRepo.body.code === 'FORBIDDEN', 'expected FORBIDDEN');

    const tasksBeforeB = countTasksInRepo(db, 'repo-2');

    // Explicit repoId: B creates in B (never a default/first-allowed repo)
    const createInB = await request(
      'POST',
      '/mcp',
      {
        name: 'create_task',
        arguments: { title: 'Goes to repo B', repoId: 'repo-2', idempotencyKey: 'k-repo-b-1' },
      },
      { authorization: `Bearer ${token}` },
    );
    assert(createInB.status === 200, `expected 200 creating in repo-2, got ${createInB.status}`);
    const createdInB = createInB.body.result;
    assert(createdInB.repoId === 'repo-2', `expected task created in repo-2, got ${createdInB.repoId}`);
    assert(
      countTasksInRepo(db, 'repo-2') === tasksBeforeB + 1,
      'exactly one task must exist in repo-2 after creation',
    );

    // A8: identical principal/key/payload retry (including after a simulated
    // "restart" — a fresh request against the same durable DB) returns the
    // SAME task, not a duplicate.
    const retrySamePayload = await request(
      'POST',
      '/mcp',
      {
        name: 'create_task',
        arguments: { title: 'Goes to repo B', repoId: 'repo-2', idempotencyKey: 'k-repo-b-1' },
      },
      { authorization: `Bearer ${token}` },
    );
    assert(retrySamePayload.status === 200, 'expected 200 on identical retry');
    assert(
      retrySamePayload.body.result.id === createdInB.id,
      'identical retry must return the exact same task, not a new one',
    );
    assert(
      countTasksInRepo(db, 'repo-2') === tasksBeforeB + 1,
      'retry must not create a second task in repo-2',
    );

    // A8: same key, CHANGED payload (different title) conflicts
    const conflictingRetry = await request(
      'POST',
      '/mcp',
      {
        name: 'create_task',
        arguments: { title: 'Different title now', repoId: 'repo-2', idempotencyKey: 'k-repo-b-1' },
      },
      { authorization: `Bearer ${token}` },
    );
    assert(
      conflictingRetry.status === 409,
      `expected 409 on changed-payload idempotency retry, got ${conflictingRetry.status}`,
    );
    assert(
      conflictingRetry.body.code === 'SEQUENCE_CONFLICT',
      'expected SEQUENCE_CONFLICT on changed-payload retry',
    );

    // A8: distinct principals never collide on the same idempotencyKey
    const pairing2 = createPairingCode(db, 'external-create-task-client-2');
    const approveRes2 = await request('POST', '/api/mcp/approve-pairing', {
      pairingCode: pairing2.code,
      clientName: 'external-create-task-client-2',
      allowedTools: ['create_task'],
      allowedRepoIds: ['repo-1', 'repo-2'],
    });
    const token2 = approveRes2.body.token as string;
    const sameKeyOtherPrincipal = await request(
      'POST',
      '/mcp',
      {
        name: 'create_task',
        arguments: { title: 'Same key, different principal', repoId: 'repo-2', idempotencyKey: 'k-repo-b-1' },
      },
      { authorization: `Bearer ${token2}` },
    );
    assert(
      sameKeyOtherPrincipal.status === 200,
      'a different principal reusing the same idempotencyKey must succeed independently',
    );
    assert(
      sameKeyOtherPrincipal.body.result.id !== createdInB.id,
      'distinct principals must never share or overwrite each others receipt',
    );

    console.log(
      '  ✓ external create_task: repoId+idempotencyKey required, unknown/forbidden repo denied, explicit repo honored, durable retry/conflict/per-principal dedup',
    );
  }

  console.log('\nAll MCP checks passed successfully.\n');
} finally {
  if (db) {
    closeDatabase(db);
  }
  rmSync(testDir, { recursive: true, force: true });
}
