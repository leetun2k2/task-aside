import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AgentDriver } from '../agent-adapter/drivers/types.ts';
import { AdapterRunManager } from '../agent-adapter/manager.ts';
import { createAdapterApp } from '../agent-adapter/service.ts';
import { mountInternalApi, mountPublicApi } from '../backend/api/index.ts';
import { closeDatabase, openDatabase } from '../backend/db/connection.ts';
import { runMigrations } from '../backend/db/migrations.ts';
import { listMessages } from '../backend/domains/chat/messages.ts';
import { createRepository } from '../backend/domains/task/repositories.ts';
import { createTask } from '../backend/domains/task/tasks.ts';
import { getTaskById } from '../backend/domains/task/tasks.ts';
import type { Message } from '../contracts/chat.ts';
import type { EventEnvelope } from '../contracts/event.ts';
import type { TaskPriority } from '../contracts/task.ts';
import {
  AdapterClient,
  BackendClient,
  BackendClientError,
  HitlCoordinator,
  RunDispatcher,
  RunReconciler,
} from './index.ts';
import { buildInstruction, formatConversationHistory } from './instruction-builder.ts';
import { TaskScheduler, sortRunnableTasks } from './scheduler.ts';
import type { TaskContext, TaskRecord } from './types.ts';

type CheckResult = { name: string; passed: boolean; error?: string };
const results: CheckResult[] = [];

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error });
    console.error(`  ✗ ${name}: ${error}`);
  }
}

process.env.TASKASIDE_INTERNAL_TOKEN = 'engine-test-internal-token';

function createTestBackend(): {
  app: Hono;
  db: ReturnType<typeof openDatabase>;
  tempDir: string;
  createRepoDir: (name: string) => string;
  createClient: (role?: 'engine' | 'supervisor') => BackendClient;
  cleanup: () => void;
} {
  const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-engine-test-'));
  const dbPath = join(tempDir, 'test.db');
  const db = openDatabase({ path: dbPath });
  runMigrations(db);

  const app = new Hono();
  mountPublicApi(app, db);
  mountInternalApi(app, db);

  return {
    app,
    db,
    tempDir,
    createRepoDir: (name: string) => {
      const dir = join(tempDir, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    createClient: (role: 'engine' | 'supervisor' = 'engine') =>
      new BackendClient({
        baseUrl: 'http://127.0.0.1:9999',
        internalToken: 'engine-test-internal-token',
        role,
        fetch: (req: Request) => app.fetch(req),
      }),

    cleanup: () => {
      closeDatabase(db);
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function createTestAdapter(
  internalToken = 'engine-test-internal-token',
  options?: { codexDriver?: AgentDriver; claudeDriver?: AgentDriver },
): {
  app: Hono;
  manager: AdapterRunManager;
  createClient: () => AdapterClient;
} {
  const manager = new AdapterRunManager(options);
  const app = createAdapterApp({
    port: 9998,
    internalToken,
    manager,
  });

  return {
    app,
    manager,
    createClient: () =>
      new AdapterClient({
        baseUrl: 'http://127.0.0.1:9998',
        internalToken,
        fetch: (req: Request) => app.fetch(req),
      }),
  };
}

function makeMockTask(id: string, priority: TaskPriority, enqueuedAt: string): TaskRecord {
  return {
    id,
    repoId: 'repo_1',
    title: id,
    status: 'todo',
    priority,
    parentId: null,
    depth: 0,
    createdAt: enqueuedAt,
    updatedAt: enqueuedAt,
    blockedReason: null,
    blockedOnChildIds: null,
    activeRunId: null,
    version: 1,
    enqueuedAt,
  };
}

console.log('--- T20: Execution Engine (Scheduler & Instruction Builder) Checks ---');

// --- 1. Pure Task Sorting: Priority Order & FIFO Tie-Breaking ---
await check('scheduler: priority order P0 > P1 > P2 > P3 and FIFO tie-breaking', () => {
  const baseTime = 1700000000000;
  const mockTasks: TaskRecord[] = [
    makeMockTask('task_p2', 'P2', new Date(baseTime).toISOString()),
    makeMockTask('task_p0_second', 'P0', new Date(baseTime + 5000).toISOString()),
    makeMockTask('task_p1', 'P1', new Date(baseTime).toISOString()),
    makeMockTask('task_p0_first', 'P0', new Date(baseTime).toISOString()),
    makeMockTask('task_p3', 'P3', new Date(baseTime).toISOString()),
  ];

  const sorted = sortRunnableTasks(mockTasks);
  const ids = sorted.map((t) => t.id);

  assert(ids[0] === 'task_p0_first', `expected task_p0_first first, got ${ids[0]}`);
  assert(ids[1] === 'task_p0_second', `expected task_p0_second second, got ${ids[1]}`);
  assert(ids[2] === 'task_p1', `expected task_p1 third, got ${ids[2]}`);
  assert(ids[3] === 'task_p2', `expected task_p2 fourth, got ${ids[3]}`);
  assert(ids[4] === 'task_p3', `expected task_p3 fifth, got ${ids[4]}`);
});

// --- 2. Live Scheduler: Priority Claiming against Backend ---
await check('scheduler: claims P0 before P2 on live backend', async () => {
  const backend = createTestBackend();
  try {
    const repoDir = backend.createRepoDir('repo-live');
    const repo = createRepository(backend.db, {
      name: 'repo-live',
      displayPath: repoDir,
      defaultProvider: 'codex',
    });

    // Create P2 task first, then P0 task
    createTask(backend.db, {
      repoId: repo.id,
      title: 'Task P2',
      priority: 'P2',
    });
    const tP0 = createTask(backend.db, {
      repoId: repo.id,
      title: 'Task P0',
      priority: 'P0',
    });

    const client = backend.createClient();
    const scheduler = new TaskScheduler(client, { ownerId: 'engine_1' });

    // Schedule next task: must pick P0 first despite being created after P2
    const step1 = await scheduler.scheduleNext();
    assert(step1.claimed === true, 'expected step1 to claim a task');
    assert(
      step1.taskId === tP0.id,
      `expected scheduler to claim P0 task ${tP0.id}, got ${step1.taskId}`,
    );
  } finally {
    backend.cleanup();
  }
});

// --- 3. One-per-tree Hold: Multiple Tasks on Same Repo Block Concurrent Claims ---
await check('scheduler: one-per-tree hold serializes tasks on the same repository', async () => {
  const backend = createTestBackend();
  try {
    const repoDir = backend.createRepoDir('repo-exclusive');
    const repo = createRepository(backend.db, {
      name: 'repo-exclusive',
      displayPath: repoDir,
      defaultProvider: 'codex',
    });

    const t1 = createTask(backend.db, {
      repoId: repo.id,
      title: 'Task 1',
      priority: 'P1',
    });
    const t2 = createTask(backend.db, {
      repoId: repo.id,
      title: 'Task 2',
      priority: 'P1',
    });

    const client = backend.createClient();
    const scheduler = new TaskScheduler(client, { ownerId: 'engine_1', maxConcurrency: 5 });

    // Claim first task
    const step1 = await scheduler.scheduleNext();
    assert(step1.claimed === true, 'step 1 should claim a task');
    const firstTaskId = step1.taskId;
    assert(
      firstTaskId === t1.id || firstTaskId === t2.id,
      'step 1 should claim one of the tasks on repo',
    );
    const secondTaskId = firstTaskId === t1.id ? t2.id : t1.id;
    assert(scheduler.isTreeBusy(repo.canonicalPath), 'working tree must be marked busy');

    // Attempt claim for second task on same repo: must NOT claim
    const step2 = await scheduler.scheduleNext();
    assert(step2.claimed === false, 'step 2 must not claim because repo is held');
    assert(
      step2.skippedReason === 'all_trees_busy',
      `expected all_trees_busy, got ${step2.skippedReason}`,
    );

    // Release task 1 in backend and scheduler
    const runId1 = step1.runId ?? '';
    assert(runId1.length > 0, 'step1.runId must be defined');
    await client.finalize(runId1, {
      ownerId: 'engine_1',
      generation: step1.generation ?? 0,
      status: 'done',
      verifiedStopped: true,
      verificationMethod: 'process_group_empty',
    });
    scheduler.releaseRun(runId1);
    assert(!scheduler.isTreeBusy(repo.canonicalPath), 'working tree must now be free');

    // Attempt claim again: second task should now be claimed!
    const step3 = await scheduler.scheduleNext();
    assert(
      step3.claimed === true && step3.taskId === secondTaskId,
      'step 3 should claim remaining task after release',
    );
  } finally {
    backend.cleanup();
  }
});

// --- 4. Busy / Blocked Trees Do Not Stall Other Repositories ---
await check(
  'scheduler: busy working tree does not stall eligible tasks on idle trees',
  async () => {
    const backend = createTestBackend();
    try {
      const repoADir = backend.createRepoDir('repo-a');
      const repoBDir = backend.createRepoDir('repo-b');
      const repoA = createRepository(backend.db, {
        name: 'repo-a',
        displayPath: repoADir,
        defaultProvider: 'codex',
      });
      const repoB = createRepository(backend.db, {
        name: 'repo-b',
        displayPath: repoBDir,
        defaultProvider: 'codex',
      });

      // Create high-priority task on Repo A, low-priority task on Repo B
      const taskA1 = createTask(backend.db, {
        repoId: repoA.id,
        title: 'Task A1',
        priority: 'P0',
      });
      const taskA2 = createTask(backend.db, {
        repoId: repoA.id,
        title: 'Task A2 (also high priority)',
        priority: 'P0',
      });
      const taskB1 = createTask(backend.db, {
        repoId: repoB.id,
        title: 'Task B1 (lower priority)',
        priority: 'P2',
      });

      const client = backend.createClient();
      const scheduler = new TaskScheduler(client, { ownerId: 'engine_1', maxConcurrency: 5 });

      // First claim gets a high-priority task on Repo A
      const step1 = await scheduler.scheduleNext();
      assert(
        step1.claimed === true && (step1.taskId === taskA1.id || step1.taskId === taskA2.id),
        'step 1 should claim a high-priority task on Repo A',
      );

      // Second claim: the remaining Task on Repo A is higher priority (P0) than Task B1 (P2), BUT Repo A is busy!
      // Scheduler must NOT stall; it must bypass Repo A and claim Task B1 on idle Repo B!
      const step2 = await scheduler.scheduleNext();
      assert(step2.claimed === true, 'step 2 must succeed');
      assert(
        step2.taskId === taskB1.id,
        `expected step 2 to claim Task B1 on idle Repo B, got ${step2.taskId}`,
      );
      assert(
        step2.workingTreeKey === repoB.canonicalPath,
        'step 2 working tree must be Repo B canonical path',
      );
    } finally {
      backend.cleanup();
    }
  },
);

// --- 5. Global Concurrency Limit Enforced ---
await check('scheduler: global concurrency ceiling enforced (default 3)', async () => {
  const backend = createTestBackend();
  try {
    const repos = [
      createRepository(backend.db, {
        name: 'repo-1',
        displayPath: backend.createRepoDir('repo-1'),
        defaultProvider: 'codex',
      }),
      createRepository(backend.db, {
        name: 'repo-2',
        displayPath: backend.createRepoDir('repo-2'),
        defaultProvider: 'codex',
      }),
      createRepository(backend.db, {
        name: 'repo-3',
        displayPath: backend.createRepoDir('repo-3'),
        defaultProvider: 'codex',
      }),
      createRepository(backend.db, {
        name: 'repo-4',
        displayPath: backend.createRepoDir('repo-4'),
        defaultProvider: 'codex',
      }),
    ];

    repos.map((r, i) =>
      createTask(backend.db, {
        repoId: r.id,
        title: `Task ${i + 1}`,
        priority: 'P1',
      }),
    );

    const client = backend.createClient();
    const scheduler = new TaskScheduler(client, { ownerId: 'engine_1', maxConcurrency: 3 });
    assert(scheduler.getMaxConcurrency() === 3, 'default/configured maxConcurrency is 3');

    // Claim 3 tasks
    const s1 = await scheduler.scheduleNext();
    const s2 = await scheduler.scheduleNext();
    const s3 = await scheduler.scheduleNext();

    assert(s1.claimed && s2.claimed && s3.claimed, 'first 3 claims must succeed');
    assert(scheduler.getActiveRunCount() === 3, 'active run count must be 3');

    // 4th claim must be blocked by concurrency limit
    const s4 = await scheduler.scheduleNext();
    assert(s4.claimed === false, '4th claim must be rejected');
    assert(
      s4.skippedReason === 'concurrency_limit_reached',
      `expected concurrency_limit_reached, got ${s4.skippedReason}`,
    );

    const first3TaskIds = new Set([s1.taskId, s2.taskId, s3.taskId]);

    // Release 1 run
    const runId1 = s1.runId ?? '';
    assert(runId1.length > 0, 's1.runId must be defined');
    scheduler.releaseRun(runId1);
    assert(scheduler.getActiveRunCount() === 2, 'active run count must be 2 after release');

    // Now 4th task can be claimed
    const s5 = await scheduler.scheduleNext();
    const s5TaskId = s5.taskId ?? '';
    assert(
      s5.claimed === true && !first3TaskIds.has(s5TaskId),
      '4th task claimed after slot freed',
    );
  } finally {
    backend.cleanup();
  }
});

// --- 6. Non-Preemption: Priority Edits and New Higher Priority Tasks Do Not Preempt Active Runs ---
await check('scheduler: higher priority tasks do not preempt active running tasks', async () => {
  const backend = createTestBackend();
  try {
    const repo1Dir = backend.createRepoDir('repo-1');
    const repo2Dir = backend.createRepoDir('repo-2');
    const repo1 = createRepository(backend.db, {
      name: 'repo-1',
      displayPath: repo1Dir,
      defaultProvider: 'codex',
    });
    const repo2 = createRepository(backend.db, {
      name: 'repo-2',
      displayPath: repo2Dir,
      defaultProvider: 'codex',
    });

    // Start with a P2 task running on repo 1
    const taskLow = createTask(backend.db, {
      repoId: repo1.id,
      title: 'Low Priority Running Task',
      priority: 'P2',
    });

    const client = backend.createClient();
    const scheduler = new TaskScheduler(client, { ownerId: 'engine_1', maxConcurrency: 1 });

    const step1 = await scheduler.scheduleNext();
    assert(step1.claimed === true && step1.taskId === taskLow.id, 'taskLow must be claimed');
    assert(scheduler.getActiveRunCount() === 1, 'active run count must be 1');

    // Now a P0 emergency task arrives on repo 2
    const taskHigh = createTask(backend.db, {
      repoId: repo2.id,
      title: 'Emergency P0 Task',
      priority: 'P0',
    });

    // Concurrency is 1, taskLow is still running. Next schedule step must NOT preempt taskLow!
    const step2 = await scheduler.scheduleNext();
    assert(step2.claimed === false, 'step 2 must not claim because concurrency limit is reached');
    assert(step2.skippedReason === 'concurrency_limit_reached', 'concurrency limit reached');

    // Verify taskLow is still active and unchanged
    const activeRuns = scheduler.getActiveRuns();
    assert(activeRuns.length === 1, 'active runs must remain 1');
    assert(
      activeRuns[0].taskId === taskLow.id,
      `active run must still be ${taskLow.id}, got ${activeRuns[0].taskId}`,
    );

    // When taskLow finishes and is released:
    const runIdLow = step1.runId ?? '';
    assert(runIdLow.length > 0, 'step1.runId must be defined');
    scheduler.releaseRun(runIdLow);
    const step3 = await scheduler.scheduleNext();
    assert(
      step3.claimed === true && step3.taskId === taskHigh.id,
      'emergency P0 task claimed after slot opened',
    );
  } finally {
    backend.cleanup();
  }
});

// --- 7. Instruction Builder: Full Structure and Scope Formatting ---
await check('instruction-builder: builds structured markdown with task, repo, and safety', () => {
  const context: TaskContext = {
    task: {
      id: 'task_abc123',
      repoId: 'repo_1',
      repositoryId: 'repo_1',
      title: 'Implement User Authentication',
      description: 'Add JWT token verification middleware to internal routes.',
      status: 'processing',
      priority: 'P0',
      parentId: null,
      originRunId: null,
      idempotencyKey: null,
      conversationId: 'conv_1',
      depth: 0,
      blockedReason: null,
      blockedOnChildIds: null,
      activeRunId: null,
      enqueuedAt: '2026-10-18T10:00:00Z',
      createdAt: '2026-10-18T10:00:00Z',
      updatedAt: '2026-10-18T10:05:00Z',
      version: 2,
    },
    repository: {
      id: 'repo_1',
      name: 'backend-service',
      displayPath: '/Users/developer/projects/backend-service',
      canonicalPath: '/Users/developer/projects/backend-service',
      defaultProvider: 'codex',
      createdAt: '2026-10-18T09:00:00Z',
    },
    parent: null,
    conversation: {
      id: 'conv_1',
      createdAt: '2026-10-18T10:00:00Z',
      updatedAt: '2026-10-18T10:00:00Z',
    },
    messages: [
      {
        id: 'msg_1',
        taskId: 'task_abc123',
        conversationId: 'conv_1',
        sender: 'user',
        content: 'Please make sure tokens expire in 1 hour.',
        inReplyToRequestId: null,
        createdAt: '2026-10-18T10:01:00Z',
      },
    ],
  };

  const instruction = buildInstruction(context);

  assert(
    instruction.includes('# Task: Implement User Authentication'),
    'must contain task title header',
  );
  assert(instruction.includes('- **Task ID**: task_abc123'), 'must contain task ID');
  assert(instruction.includes('- **Priority**: P0'), 'must contain priority');
  assert(instruction.includes('Add JWT token verification middleware'), 'must contain description');
  assert(
    instruction.includes('`/Users/developer/projects/backend-service`'),
    'must contain canonical path',
  );
  assert(
    instruction.includes('You MUST confine all file edits and inspection strictly'),
    'must contain repo boundary note',
  );
  assert(
    instruction.includes('Please make sure tokens expire in 1 hour.'),
    'must contain chat message',
  );
  assert(
    instruction.includes('## Non-Negotiable Safety Guidelines'),
    'must contain safety guidelines',
  );
  assert(
    instruction.includes('Do not run `git commit`, `git push`'),
    'must forbid unauthorized git operations',
  );
  assert(
    !instruction.includes('## Parent Task Context'),
    'must not contain parent context if null',
  );
});

// --- 8. Instruction Builder: Subtask with Parent Task Context ---
await check('instruction-builder: includes parent task context for delegated children', () => {
  const context: TaskContext = {
    task: {
      id: 'task_child',
      repoId: 'repo_1',
      repositoryId: 'repo_1',
      title: 'Add JWT verify function',
      description: 'Helper function for HS256 validation.',
      status: 'processing',
      priority: 'P1',
      parentId: 'task_parent_999',
      originRunId: 'run_parent_1',
      idempotencyKey: 'idemp_child_1',
      conversationId: 'conv_child',
      depth: 1,
      blockedReason: null,
      blockedOnChildIds: null,
      activeRunId: null,
      enqueuedAt: '2026-10-18T11:00:00Z',
      createdAt: '2026-10-18T11:00:00Z',
      updatedAt: '2026-10-18T11:05:00Z',
      version: 1,
    },
    repository: {
      id: 'repo_1',
      name: 'auth-repo',
      displayPath: '/tmp/auth-repo',
      canonicalPath: '/tmp/auth-repo',
      defaultProvider: 'codex',
      createdAt: '2026-10-18T09:00:00Z',
    },
    parent: {
      id: 'task_parent_999',
      repoId: 'repo_1',
      repositoryId: 'repo_1',
      title: 'Full Auth System',
      description: 'Parent architecture task overseeing authentication.',
      status: 'processing',
      priority: 'P0',
      parentId: null,
      originRunId: null,
      idempotencyKey: null,
      conversationId: 'conv_parent',
      depth: 0,
      blockedReason: 'Waiting for child tasks',
      blockedOnChildIds: ['task_child'],
      activeRunId: null,
      enqueuedAt: '2026-10-18T10:00:00Z',
      createdAt: '2026-10-18T10:00:00Z',
      updatedAt: '2026-10-18T10:30:00Z',
      version: 3,
    },
    conversation: {
      id: 'conv_child',
      createdAt: '2026-10-18T11:00:00Z',
      updatedAt: '2026-10-18T11:00:00Z',
    },
    messages: [],
  };

  const instruction = buildInstruction(context);

  assert(instruction.includes('## Parent Task Context'), 'must contain parent task context header');
  assert(instruction.includes('- **Parent ID**: task_parent_999'), 'must contain parent ID');
  assert(instruction.includes('- **Parent Title**: Full Auth System'), 'must contain parent title');
  assert(
    instruction.includes('Parent architecture task overseeing authentication.'),
    'must contain parent goal',
  );
  assert(
    instruction.includes('*(No prior conversation messages)*'),
    'must handle empty messages cleanly',
  );
});

// --- 9. Instruction Builder: Context History Bounding (Truncation) ---
await check('instruction-builder: bounds conversation history cleanly within message limit', () => {
  const messages: Message[] = [];
  for (let i = 1; i <= 50; i++) {
    messages.push({
      id: `msg_${i}`,
      taskId: 'conv_1',
      conversationId: 'conv_1',
      sender: i % 2 === 1 ? 'user' : 'agent',
      content: `Message ${i}: testing bounding logic.`,
      inReplyToRequestId: null,
      createdAt: `2026-10-18T10:${i < 10 ? `0${i}` : i}:00Z`,
    });
  }

  const formatted = formatConversationHistory(messages, { maxHistoryMessages: 10 });

  assert(
    formatted.includes('Earlier conversation history truncated (40 earlier messages omitted'),
    'must include truncation warning header',
  );
  assert(formatted.includes('Message 50: testing bounding logic.'), 'must include latest message');
  assert(
    formatted.includes('Message 41: testing bounding logic.'),
    'must include earliest message in window (message 41)',
  );
  assert(
    !formatted.includes('Message 35: testing bounding logic.'),
    'must not include truncated message 35',
  );
});

// --- 10. Instruction Builder: Character Budget Bounding ---
await check('instruction-builder: bounds conversation history within character budget', () => {
  const messages: Message[] = [
    {
      id: 'msg_old',
      taskId: 'conv_1',
      conversationId: 'conv_1',
      sender: 'user',
      content: 'A'.repeat(500),
      inReplyToRequestId: null,
      createdAt: '2026-10-18T10:00:00Z',
    },
    {
      id: 'msg_new',
      taskId: 'conv_1',
      conversationId: 'conv_1',
      sender: 'user',
      content: 'Recent important prompt',
      inReplyToRequestId: null,
      createdAt: '2026-10-18T10:01:00Z',
    },
  ];

  // Restrict character budget to 200 chars: msg_old (500 chars) cannot fit, msg_new (23 chars) fits
  const formatted = formatConversationHistory(messages, { maxHistoryCharacters: 200 });

  assert(formatted.includes('Recent important prompt'), 'must preserve latest message');
  assert(!formatted.includes('A'.repeat(500)), 'must drop oversized older message');
  assert(formatted.includes('Earlier conversation history truncated'), 'must note truncation');
});

// --- 11. Process Boundary Check: Zero database driver imports in execution-engine modules ---
await check('boundary: zero database driver imports in execution-engine modules', () => {
  const runtimeFiles = [
    join(import.meta.dir, 'scheduler.ts'),
    join(import.meta.dir, 'client.ts'),
    join(import.meta.dir, 'instruction-builder.ts'),
    join(import.meta.dir, 'dispatcher.ts'),
    join(import.meta.dir, 'index.ts'),
    join(import.meta.dir, 'types.ts'),
    join(import.meta.dir, '../cmd/execution-engine.ts'),
  ];

  const violations: string[] = [];
  const sqlitePkg = ['bun', 'sqlite'].join(':');
  const importRegex = new RegExp(`from\\s+['"]${sqlitePkg}['"]|require\\(['"]${sqlitePkg}['"]\\)`);

  for (const filePath of runtimeFiles) {
    const content = readFileSync(filePath, 'utf8');
    if (importRegex.test(content)) {
      violations.push(filePath);
    }
  }

  assert(
    violations.length === 0,
    `Found forbidden database driver imports in execution-engine runtime files: ${violations.join(', ')}`,
  );
});

// --- 12. Dispatch: Backend Claim Strictly Precedes Adapter Start ---
await check('dispatch: backend claim strictly precedes adapter start', async () => {
  const backend = createTestBackend();
  const adapter = createTestAdapter();
  try {
    const repoPath = backend.createRepoDir('repo_t21_claim');
    const repo = createRepository(backend.db, {
      name: 'repo_t21_claim',
      displayPath: repoPath,
      defaultProvider: 'codex',
    });

    const task = createTask(backend.db, {
      repoId: repo.id,
      title: 'Task Claim First',
      priority: 'P1',
    });

    const bClient = backend.createClient();
    const aClient = adapter.createClient();
    const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t21_claim' });

    // Step 1: Scheduler claims task from backend first
    const schedResult = await scheduler.scheduleNext();
    assert(schedResult.claimed, 'scheduler must successfully claim task');
    assert(schedResult.runId !== undefined, 'claim must return a valid runId');
    assert(schedResult.generation === 1, 'initial generation must be 1');

    // Verify task status in backend is now processing
    const taskInDb = getTaskById(backend.db, task.id);
    assert(taskInDb?.status === 'processing', 'backend task status must be processing');

    // Step 2: Now dispatcher starts run on adapter
    const context = await bClient.getTaskContext(task.id);
    const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
      ownerId: 'engine_t21_claim',
    });

    const dispatchRes = await dispatcher.dispatchTask({
      task: taskInDb as unknown as TaskRecord,
      claim: {
        runId: schedResult.runId ?? '',
        taskId: task.id,
        generation: schedResult.generation ?? 1,
        status: 'running',
        workingTreeKey: schedResult.workingTreeKey ?? '',
      },
      context,
      scenario: 'success',
    });

    assert(dispatchRes.status === 'done', 'dispatch must complete successfully');
    assert(dispatchRes.verifiedStopped, 'run must be verified stopped');
  } finally {
    backend.cleanup();
  }
});

// --- 13. Dispatch: Duplicate Start on Adapter is Idempotent ---
await check(
  'dispatch: duplicate start on adapter is idempotent and does not spawn second run',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t21_idempotent');
      const aClient = adapter.createClient();

      const startPayload = {
        runId: 'run_idem_test',
        taskId: 'task_idem_test',
        provider: 'codex' as const,
        cwd: repoPath,
        instruction: 'Do something',
        ownerId: 'engine_idem',
        generation: 1,
      };

      const first = await aClient.startRun(startPayload, { scenario: 'success' });
      assert(first.runId === 'run_idem_test', 'first start must succeed');
      assert(first.started, 'first start must report started');

      const second = await aClient.startRun(startPayload, { scenario: 'success' });
      assert(second.runId === 'run_idem_test', 'second start must return same runId');
      assert(second.started, 'second start must be marked started');
      assert(
        (second as { existing?: boolean }).existing === true,
        'second start must indicate existing run',
      );
    } finally {
      backend.cleanup();
    }
  },
);

// --- 14. Events: Durable Events Forwarded, Acknowledged, and Retried Unchanged on Lost ACK ---
await check(
  'events: durable events forwarded, acknowledged, and retried unchanged on lost ACK',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t21_retry');
      const repo = createRepository(backend.db, {
        name: 'repo_t21_retry',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Lost ACK Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t21_ack' });

      const schedResult = await scheduler.scheduleNext();
      assert(schedResult.claimed, 'scheduler must claim task');

      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t21_ack',
        maxRetries: 3,
        retryDelayMs: 10,
      });

      // Run scenario 'success' with simulateLostAck: true.
      // The first attempt will get a 503 from backend (simulated lost ACK),
      // and dispatcher will retry with the identical event payload unchanged.
      const dispatchRes = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: schedResult.runId ?? '',
          taskId: task.id,
          generation: schedResult.generation ?? 1,
          status: 'running',
          workingTreeKey: schedResult.workingTreeKey ?? '',
        },
        context,
        scenario: 'success',
        simulateLostAck: true,
      });

      assert(
        dispatchRes.status === 'done',
        'dispatch must complete successfully despite dropped ACK',
      );

      // Verify conversation has the agent message from scenario
      const messages = listMessages(backend.db, task.conversationId).messages;
      assert(messages.length > 0, 'conversation must contain committed message');
      const agentMsg = messages.find((m) => m.sender === 'agent');
      assert(agentMsg !== undefined, 'agent message must exist');
      assert(agentMsg?.content === 'Working on it, done.', 'message content must match');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 15. Events: Deltas Coalesce Without Delaying Control Events ---
await check('events: deltas coalesce without delaying control events', async () => {
  const backend = createTestBackend();
  const adapter = createTestAdapter();
  try {
    const repoPath = backend.createRepoDir('repo_t21_delta');
    const repo = createRepository(backend.db, {
      name: 'repo_t21_delta',
      displayPath: repoPath,
      defaultProvider: 'codex',
    });

    const task = createTask(backend.db, {
      repoId: repo.id,
      title: 'Task Delta Coalesce',
      priority: 'P1',
    });

    const bClient = backend.createClient();
    const aClient = adapter.createClient();
    const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t21_coalesce' });
    const schedResult = await scheduler.scheduleNext();
    assert(schedResult.claimed, 'task must be claimed');

    const runId = schedResult.runId ?? '';
    const generation = schedResult.generation ?? 1;

    const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
      ownerId: 'engine_t21_coalesce',
      deltaCoalesceMs: 500, // Large debounce window (500ms) to prove control event does not wait!
    });

    const now = new Date().toISOString();

    const delta1: EventEnvelope = {
      runId,
      sequence: 1,
      type: 'message.delta',
      timestamp: now,
      data: { messageId: 'msg_delta_1', delta: 'Hello ' },
    };
    const delta2: EventEnvelope = {
      runId,
      sequence: 2,
      type: 'message.delta',
      timestamp: now,
      data: { messageId: 'msg_delta_1', delta: 'brave ' },
    };
    const delta3: EventEnvelope = {
      runId,
      sequence: 3,
      type: 'message.delta',
      timestamp: now,
      data: { messageId: 'msg_delta_1', delta: 'new ' },
    };
    const delta4: EventEnvelope = {
      runId,
      sequence: 4,
      type: 'message.delta',
      timestamp: now,
      data: { messageId: 'msg_delta_1', delta: 'world!' },
    };
    const controlEvent: EventEnvelope = {
      runId,
      sequence: 5,
      type: 'message.completed',
      timestamp: now,
      data: { messageId: 'msg_delta_1', content: 'Hello brave new world!' },
    };

    adapter.manager.setDriver('codex', {
      provider: 'codex',
      start: async (_run, callbacks) => {
        callbacks.onEvent(delta1);
        callbacks.onEvent(delta2);
        callbacks.onEvent(delta3);
        callbacks.onEvent(delta4);
        callbacks.onEvent(controlEvent);
        callbacks.onEvent({
          runId,
          sequence: 6,
          type: 'completed',
          timestamp: now,
          data: { summary: 'Done' },
        });
        callbacks.onEnd();
      },
      cancel: async () => ({
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      }),
    });

    const startTime = Date.now();
    const context = await bClient.getTaskContext(task.id);
    const dispatchRes = await dispatcher.dispatchTask({
      task: task as unknown as TaskRecord,
      claim: {
        runId,
        taskId: task.id,
        generation,
        status: 'running',
        workingTreeKey: schedResult.workingTreeKey ?? '',
      },
      context,
    });

    const elapsed = Date.now() - startTime;
    assert(
      elapsed < 400,
      `Control event must NOT be delayed by 500ms delta timer (elapsed: ${elapsed}ms)`,
    );
    assert(dispatchRes.status === 'done', 'dispatch must complete');

    const messages = listMessages(backend.db, task.conversationId).messages;
    assert(messages.length === 1, 'must have 1 completed message in conversation');
    assert(
      messages[0].content === 'Hello brave new world!',
      'message content must match control event',
    );
  } finally {
    backend.cleanup();
  }
});

// --- 16. Disconnect: SSE Disconnect Recovery Reconnects Without Spawning Second Run ---
await check(
  'disconnect: SSE disconnect recovery reconnects with ?after=seq without spawning second run',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t21_disconnect');
      const repo = createRepository(backend.db, {
        name: 'repo_t21_disconnect',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Disconnect Recovery',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t21_disc' });
      const schedResult = await scheduler.scheduleNext();
      assert(schedResult.claimed, 'task must be claimed');

      let startRunCount = 0;
      const originalStartRun = aClient.startRun.bind(aClient);
      aClient.startRun = async (req, extra) => {
        startRunCount++;
        return originalStartRun(req, extra);
      };

      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t21_disc',
      });

      // Run with 'disconnect' scenario: emits delta 1 and closes SSE stream
      const dispatchRes = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: schedResult.runId ?? '',
          taskId: task.id,
          generation: schedResult.generation ?? 1,
          status: 'running',
          workingTreeKey: schedResult.workingTreeKey ?? '',
        },
        context,
        scenario: 'disconnect',
      });

      // Verify startRun was called EXACTLY ONCE (preceding claim, never in disconnect recovery)
      assert(startRunCount === 1, `startRun must only be called once, got ${startRunCount}`);
      assert(dispatchRes.lastSequence >= 1, 'must have processed events before/after disconnect');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 17. Lifecycle: Terminal Run Finalizes Backend With VerifiedStopped: true and Releases Lock ---
await check(
  'lifecycle: terminal run completion finalizes backend with verifiedStopped: true and releases scheduler lock',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t21_lifecycle');
      const repo = createRepository(backend.db, {
        name: 'repo_t21_lifecycle',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const task1 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Lifecycle 1',
        priority: 'P1',
      });
      const task2 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Lifecycle 2',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t21_life' });

      // Claim and run task1 to completion
      const sched1 = await scheduler.scheduleNext();
      assert(sched1.claimed, 'task 1 must be claimed');
      assert(scheduler.getActiveRunCount() === 1, 'scheduler must have 1 active run');

      const context1 = await bClient.getTaskContext(task1.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t21_life',
      });

      const res1 = await dispatcher.dispatchTask({
        task: task1 as unknown as TaskRecord,
        claim: {
          runId: sched1.runId ?? '',
          taskId: task1.id,
          generation: sched1.generation ?? 1,
          status: 'running',
          workingTreeKey: sched1.workingTreeKey ?? '',
        },
        context: context1,
        scenario: 'success',
      });

      assert(res1.status === 'done', 'task 1 must complete');
      assert(res1.verifiedStopped, 'task 1 must be verified stopped');
      assert(
        scheduler.getActiveRunCount() === 0,
        'scheduler active runs must be released after completion',
      );

      // Verify task2 on the SAME working tree can now be claimed immediately without LOCK_HELD!
      const sched2 = await scheduler.scheduleNext();
      assert(sched2.claimed, 'task 2 on same tree must be claimable now that lock was released');
      assert(sched2.runId !== undefined, 'task 2 must have a valid runId');
      assert(
        sched2.generation === 2,
        'subsequent claim on same tree must increment generation to 2',
      );
    } finally {
      backend.cleanup();
    }
  },
);

// --- 18. Safety: Sequence Conflict on Event Forwarding Aborts Without Retry ---
await check('safety: sequence conflict on event forwarding aborts without retry', async () => {
  const backend = createTestBackend();
  const adapter = createTestAdapter();
  try {
    const repoPath = backend.createRepoDir('repo_t21_conflict');
    const repo = createRepository(backend.db, {
      name: 'repo_t21_conflict',
      displayPath: repoPath,
      defaultProvider: 'codex',
    });

    const task = createTask(backend.db, {
      repoId: repo.id,
      title: 'Task Sequence Conflict',
      priority: 'P1',
    });

    const bClient = backend.createClient();
    const aClient = adapter.createClient();
    const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t21_conflict' });
    const sched = await scheduler.scheduleNext();
    assert(sched.claimed, 'task must be claimed');

    const runId = sched.runId ?? '';
    const generation = sched.generation ?? 1;

    const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
      ownerId: 'engine_t21_conflict',
      maxRetries: 3,
    });

    const now = new Date().toISOString();
    // 1. Ingest sequence 1 with payload A
    const event1: EventEnvelope = {
      runId,
      sequence: 1,
      type: 'message.completed',
      timestamp: now,
      data: { messageId: 'msg_conflict_1', content: 'Payload A' },
    };
    await dispatcher.forwardWithRetry(runId, generation, [event1]);

    // 2. Ingest sequence 1 with DIFFERENT payload B -> must fail with 409 SEQUENCE_CONFLICT immediately
    const event2: EventEnvelope = {
      runId,
      sequence: 1,
      type: 'message.completed',
      timestamp: now,
      data: { messageId: 'msg_conflict_1', content: 'Payload B (Conflicting)' },
    };

    let caughtError: BackendClientError | null = null;
    try {
      await dispatcher.forwardWithRetry(runId, generation, [event2]);
    } catch (err: unknown) {
      if (err instanceof BackendClientError) {
        caughtError = err;
      }
    }

    assert(caughtError !== null, 'must catch error on sequence conflict');
    assert(caughtError?.status === 409, 'status must be 409');
    assert(caughtError?.code === 'SEQUENCE_CONFLICT', 'error code must be SEQUENCE_CONFLICT');
  } finally {
    backend.cleanup();
  }
});

// --- 19. Failure: Run Failure Finalizes Backend as Error and Releases Scheduler Lock ---
await check(
  'failure: run failure finalizes backend with error, verifiedStopped: true, and releases scheduler lock',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t21_failure');
      const repo = createRepository(backend.db, {
        name: 'repo_t21_failure',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Failure Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t21_fail' });

      const sched = await scheduler.scheduleNext();
      assert(sched.claimed, 'task must be claimed');
      assert(scheduler.getActiveRunCount() === 1, 'active run count must be 1');

      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t21_fail',
      });

      const dispatchRes = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          taskId: task.id,
          generation: sched.generation ?? 1,
          status: 'running',
          workingTreeKey: sched.workingTreeKey ?? '',
        },
        context,
        scenario: 'failure',
      });

      assert(dispatchRes.status === 'error', 'dispatch status must be error');
      assert(dispatchRes.verifiedStopped, 'must be verified stopped');
      assert(scheduler.getActiveRunCount() === 0, 'scheduler lock must be released on failure');

      const updatedTask = getTaskById(backend.db, task.id);
      assert(updatedTask?.status === 'error', 'task status in database must be error');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 20. HITL: Input Required Pauses Run in HITL Status and Retains Scheduler Lock ---
await check(
  'hitl: input_required event pauses run in hitl status, transitions task to hitl, and retains scheduler lock',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t21_hitl');
      const repo = createRepository(backend.db, {
        name: 'repo_t21_hitl',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task HITL Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t21_hitl' });

      const sched = await scheduler.scheduleNext();
      assert(sched.claimed, 'task must be claimed');

      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t21_hitl',
      });

      const dispatchRes = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          taskId: task.id,
          generation: sched.generation ?? 1,
          status: 'running',
          workingTreeKey: sched.workingTreeKey ?? '',
        },
        context,
        scenario: 'hitl',
      });

      assert(dispatchRes.status === 'hitl', 'dispatch status must be hitl');
      // In HITL, the run is paused waiting for user reply, so it is NOT finalized and scheduler lock is retained
      assert(
        scheduler.getActiveRunCount() === 1,
        'scheduler lock must be retained during HITL pause',
      );

      const updatedTask = getTaskById(backend.db, task.id);
      assert(updatedTask?.status === 'hitl', 'task status in database must be hitl');
    } finally {
      backend.cleanup();
    }
  },
);

console.log('--- T22: Cancel, Crashes, and Reconciliation Checks ---');

// --- 21. Cancel: Calling cancelRun Stops Process via Adapter With Verified Stopped Proof, Finalizes Run as Cancelled, and Releases Lock ---
await check(
  'cancel: calling cancelRun stops process via adapter with verifiedStopped: true, finalizes run as cancelled, and releases lock',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t22_cancel');
      const repo = createRepository(backend.db, {
        name: 'repo_t22_cancel',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });
      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Cancel Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t22_cancel' });
      const sched = await scheduler.scheduleNext();
      assert(sched.claimed, 'task must be claimed');

      const runId = sched.runId ?? '';
      const generation = sched.generation ?? 1;

      // Start run on adapter in 'crash' scenario (stays running)
      const context = await bClient.getTaskContext(task.id);
      const instruction = buildInstruction(context);
      await aClient.startRun(
        {
          runId,
          taskId: task.id,
          provider: 'codex',
          cwd: repoPath,
          instruction,
          ownerId: 'engine_t22_cancel',
          generation,
        },
        { scenario: 'crash' },
      );

      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t22_cancel',
      });

      const cancelRes = await dispatcher.cancelRun(runId, generation);
      assert(cancelRes.ok === true, 'cancel must succeed');
      assert(cancelRes.verifiedStopped === true, 'cancel must verify process stopped');
      assert(cancelRes.status === 'cancelled', 'cancel status must be cancelled');

      // Verify database state: run and task are cancelled, and scheduler lock is released
      const runStatus = await bClient.getTaskContext(task.id);
      assert(runStatus.task.status === 'cancelled', 'task must be cancelled');
      assert(scheduler.getActiveRunCount() === 0, 'scheduler active runs must be 0');

      // Verify a new task on the same repository can now be claimed immediately!
      createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Cancel Test 2',
        priority: 'P1',
      });
      const sched2 = await scheduler.scheduleNext();
      assert(sched2.claimed, 'task 2 must be claimed on same tree now that lock was released');
      assert(sched2.generation === 2, 'subsequent claim increments generation to 2');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 22. Cancel: Failure to Verify Process Termination Quarantines Run and Blocks Subsequent Claims ---
await check(
  'cancel: cancel failure or unverified stop calls markUncertain, quarantines working tree, and blocks subsequent claims',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t22_cancel_fail');
      const repo = createRepository(backend.db, {
        name: 'repo_t22_cancel_fail',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });
      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Cancel Fail Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t22_cfail' });
      const sched = await scheduler.scheduleNext();
      assert(sched.claimed, 'task must be claimed');

      const runId = sched.runId ?? '';
      const generation = sched.generation ?? 1;

      // Mock adapterClient.cancelRun to reject (simulating unkillable process or adapter error)
      aClient.cancelRun = async () => {
        throw new Error('Adapter cancel failed to terminate process tree');
      };

      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t22_cfail',
      });

      const cancelRes = await dispatcher.cancelRun(runId, generation);
      assert(cancelRes.ok === false, 'cancel must report not ok');
      assert(cancelRes.status === 'uncertain', 'status must be uncertain');
      assert(cancelRes.verifiedStopped === false, 'verifiedStopped must be false');

      // Verify working tree is quarantined in database
      const lock = backend.db
        .query('SELECT quarantined, owner_run_id FROM run_locks WHERE working_tree_key = ?')
        .get(repo.canonicalPath) as { quarantined: number; owner_run_id: string } | null;
      assert(lock?.quarantined === 1, 'working tree lock must be quarantined');

      // Attempt to claim another task on the quarantined tree: cannot be claimed!
      createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Blocked on Quarantined Tree',
        priority: 'P0',
      });
      const schedAttempt = await scheduler.scheduleNext();
      assert(schedAttempt.claimed === false, 'cannot claim task on quarantined tree');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 23. Fault: Adapter startRun Failure Immediately Marks Run Uncertain and Quarantines Tree ---
await check(
  'fault: adapter startRun failure immediately marks run uncertain, quarantines working tree, and releases scheduler slot',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t22_start_fault');
      const repo = createRepository(backend.db, {
        name: 'repo_t22_start_fault',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });
      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Start Fault',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t22_fault' });
      const sched = await scheduler.scheduleNext();
      assert(sched.claimed, 'task must be claimed');

      // Simulate adapter crashing/unreachable on startRun
      aClient.startRun = async () => {
        throw new Error('Connection refused to agent-adapter');
      };

      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t22_fault',
      });

      const dispatchRes = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          taskId: task.id,
          generation: sched.generation ?? 1,
          status: 'running',
          workingTreeKey: sched.workingTreeKey ?? '',
        },
        context,
      });

      assert(dispatchRes.status === 'uncertain', 'status must be uncertain');
      assert(dispatchRes.verifiedStopped === false, 'cannot be verified stopped');
      assert(scheduler.getActiveRunCount() === 0, 'scheduler slot must be released');

      // Working tree must be quarantined in database
      const lock = backend.db
        .query('SELECT quarantined FROM run_locks WHERE working_tree_key = ?')
        .get(repo.canonicalPath) as { quarantined: number } | null;
      assert(lock?.quarantined === 1, 'tree must be quarantined');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 24. Crash: Adapter Death / 404 During Disconnect Recovery Marks Run Uncertain and Quarantines Tree ---
await check(
  'crash: adapter death/404 during disconnect recovery marks run uncertain and quarantines working tree',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t22_adapter_crash');
      const repo = createRepository(backend.db, {
        name: 'repo_t22_adapter_crash',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });
      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Adapter Crash',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t22_crash' });
      const sched = await scheduler.scheduleNext();
      assert(sched.claimed, 'task must be claimed');

      // Disconnect scenario: stream drops. When getRunStatus is queried, simulate adapter restart by wiping runs
      const originalStreamEvents = aClient.streamEvents.bind(aClient);
      aClient.streamEvents = async (runId, after, opts) => {
        // Clear all adapter runs to simulate adapter process crash and restart with fresh state
        setTimeout(() => {
          (adapter.manager as unknown as { runs: Map<string, unknown> }).runs.clear();
        }, 10);
        return originalStreamEvents(runId, after, opts);
      };

      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t22_crash',
      });

      const dispatchRes = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          taskId: task.id,
          generation: sched.generation ?? 1,
          status: 'running',
          workingTreeKey: sched.workingTreeKey ?? '',
        },
        context,
        scenario: 'disconnect',
      });

      assert(dispatchRes.status === 'uncertain', 'status must be uncertain');
      assert(dispatchRes.verifiedStopped === false, 'must be unverified stopped');

      const lock = backend.db
        .query('SELECT quarantined FROM run_locks WHERE working_tree_key = ?')
        .get(repo.canonicalPath) as { quarantined: number } | null;
      assert(lock?.quarantined === 1, 'tree must be quarantined');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 25. Quarantine: Quarantined Working Tree Blocks Reuse Even On High Priority P0 Claims ---
await check(
  'quarantine: quarantined working tree blocks reuse even on explicit retry or high priority P0 claim',
  async () => {
    const backend = createTestBackend();
    try {
      const repoPath = backend.createRepoDir('repo_t22_quarantine_block');
      const repo = createRepository(backend.db, {
        name: 'repo_t22_quarantine_block',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });
      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Quarantined Tree',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const claim = await bClient.claimTask(task.id, {
        ownerId: 'engine_t22_qblock',
        generation: 0,
        idempotencyKey: 'idemp_qblock_1',
      });

      // Mark run uncertain
      await bClient.markUncertain(claim.runId, {
        ownerId: 'engine_t22_qblock',
        generation: claim.generation,
        reason: 'Simulated process crash',
      });

      // Now attempt another P0 claim on the SAME tree
      const p0Task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Emergency P0 Task on Quarantined Tree',
        priority: 'P0',
      });

      let caughtError: BackendClientError | null = null;
      try {
        await bClient.claimTask(p0Task.id, {
          ownerId: 'engine_t22_qblock',
          generation: 0,
          idempotencyKey: 'idemp_qblock_2',
        });
      } catch (err: unknown) {
        if (err instanceof BackendClientError) caughtError = err;
      }

      assert(caughtError !== null, 'claim on quarantined tree must throw error');
      assert(caughtError?.status === 409, 'status must be 409');
      assert(caughtError?.code === 'LOCK_HELD', 'error code must be LOCK_HELD');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 26. Recovery: Supervisor clear-quarantine Resets Quarantine Flag and Unblocks Working Tree ---
await check(
  'recovery: supervisor clear-quarantine resets quarantine flag and unblocks working tree for new claims',
  async () => {
    const backend = createTestBackend();
    try {
      const repoPath = backend.createRepoDir('repo_t22_quarantine_clear');
      const repo = createRepository(backend.db, {
        name: 'repo_t22_quarantine_clear',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });
      const task1 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Quarantined 1',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const claim1 = await bClient.claimTask(task1.id, {
        ownerId: 'engine_t22_qclear',
        generation: 0,
        idempotencyKey: 'idemp_qclear_1',
      });

      await bClient.markUncertain(claim1.runId, {
        ownerId: 'engine_t22_qclear',
        generation: claim1.generation,
        reason: 'Uncertain run crash',
      });

      // Supervisor clears quarantine
      const supervisorClient = backend.createClient('supervisor');
      const clearRes = await supervisorClient.clearQuarantine(claim1.runId, {
        operatorId: 'supervisor_1',
        reason: 'Operator manually verified process termination',
      });
      assert(clearRes.ok === true, 'clear-quarantine must succeed');

      // Verify lock in database: quarantined = 0
      const lock = backend.db
        .query('SELECT quarantined FROM run_locks WHERE working_tree_key = ?')
        .get(repo.canonicalPath) as { quarantined: number } | null;
      assert(lock?.quarantined === 0, 'quarantined flag must be cleared');

      // Now create and claim a new task on the same repository: must succeed!
      const task2 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task After Quarantine Clear',
        priority: 'P1',
      });
      const claim2 = await bClient.claimTask(task2.id, {
        ownerId: 'engine_t22_qclear',
        generation: 0,
        idempotencyKey: 'idemp_qclear_2',
      });
      assert(claim2.runId !== undefined, 'claim 2 must succeed');
      assert(claim2.generation === claim1.generation + 1, 'generation must increment');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 27. Lease/TTL: Backend Never Auto-Releases Working Tree Lock on Lease Expiration ---
await check(
  'lease/ttl: lease expiration on backend NEVER auto-releases working tree lock to another claim',
  async () => {
    const backend = createTestBackend();
    try {
      const repoPath = backend.createRepoDir('repo_t22_ttl');
      const repo = createRepository(backend.db, {
        name: 'repo_t22_ttl',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });
      const task1 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task TTL 1',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const claim1 = await bClient.claimTask(task1.id, {
        ownerId: 'engine_t22_ttl',
        generation: 0,
        idempotencyKey: 'idemp_ttl_1',
      });

      // Artificially expire the lease in SQLite
      const expiredDate = new Date(Date.now() - 100_000).toISOString();
      backend.db
        .query('UPDATE run_locks SET lease_expires_at = ? WHERE working_tree_key = ?')
        .run(expiredDate, repo.canonicalPath);

      // Attempt to claim another task on the same tree: MUST FAIL with LOCK_HELD!
      const task2 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task TTL 2',
        priority: 'P0',
      });

      let caughtError: BackendClientError | null = null;
      try {
        await bClient.claimTask(task2.id, {
          ownerId: 'engine_t22_ttl_other',
          generation: 0,
          idempotencyKey: 'idemp_ttl_2',
        });
      } catch (err: unknown) {
        if (err instanceof BackendClientError) caughtError = err;
      }

      assert(caughtError !== null, 'claim on expired lease must still be rejected');
      assert(caughtError?.status === 409, 'status must be 409');
      assert(caughtError?.code === 'LOCK_HELD', 'must reject with LOCK_HELD');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 28. Retry: Explicit Retry After Clean Error Creates New Run With Incremented Generation ---
await check(
  'retry: explicit retry after clean error creates new run with incremented generation',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t22_retry');
      const repo = createRepository(backend.db, {
        name: 'repo_t22_retry',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });
      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Retry Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t22_retry' });

      // First run: fails cleanly
      const sched1 = await scheduler.scheduleNext();
      assert(sched1.claimed, 'task must be claimed');
      const runId1 = sched1.runId ?? '';
      const gen1 = sched1.generation ?? 1;

      const context1 = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t22_retry',
      });

      const res1 = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: runId1,
          taskId: task.id,
          generation: gen1,
          status: 'running',
          workingTreeKey: sched1.workingTreeKey ?? '',
        },
        context: context1,
        scenario: 'failure',
      });

      assert(res1.status === 'error', 'first run must end in error');
      assert(res1.verifiedStopped, 'must be verified stopped');
      assert(scheduler.getActiveRunCount() === 0, 'scheduler lock must be released');

      // User calls explicit retry via POST /api/tasks/:id/retry
      const retryResult = await bClient.retryTask(task.id);
      assert(retryResult.status === 'todo', 'task must transition to todo after retry');

      // Scheduler claims it again: must produce new runId with incremented generation!
      const sched2 = await scheduler.scheduleNext();
      assert(sched2.claimed, 'retried task must be claimed by scheduler');
      assert(sched2.runId !== runId1, 'new runId must differ from failed runId');
      assert(sched2.generation === gen1 + 1, 'generation must be incremented to 2');

      // Second run completes successfully
      const context2 = await bClient.getTaskContext(task.id);
      const res2 = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched2.runId ?? '',
          taskId: task.id,
          generation: sched2.generation ?? 2,
          status: 'running',
          workingTreeKey: sched2.workingTreeKey ?? '',
        },
        context: context2,
        scenario: 'success',
      });
      assert(res2.status === 'done', 'second run must complete successfully');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 29. Reconciler: Reconciles Terminal Adapter Runs With Verified Stopped Proof ---
await check(
  'reconciler: reconciles terminal adapter runs with verified stopped proof to backend',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t22_rec_term');
      const repo = createRepository(backend.db, {
        name: 'repo_t22_rec_term',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });
      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Reconciler Terminal',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t22_rec' });
      const sched = await scheduler.scheduleNext();
      assert(sched.claimed, 'task must be claimed');

      const runId = sched.runId ?? '';
      const generation = sched.generation ?? 1;

      // Start run on adapter in 'success' scenario (reaches done)
      const context = await bClient.getTaskContext(task.id);
      const instruction = buildInstruction(context);
      await aClient.startRun(
        {
          runId,
          taskId: task.id,
          provider: 'codex',
          cwd: repoPath,
          instruction,
          ownerId: 'engine_t22_rec',
          generation,
        },
        { scenario: 'success' },
      );

      // Wait a tick for adapter to complete
      await new Promise((r) => setTimeout(r, 20));

      const reconciler = new RunReconciler(bClient, aClient, scheduler, {
        ownerId: 'engine_t22_rec',
      });

      const recResult = await reconciler.reconcileRun(runId, generation);
      assert(recResult.reconciled === true, 'run must be reconciled');
      assert(recResult.status === 'done', 'reconciled status must be done');
      assert(recResult.quarantined === false, 'must not be quarantined');
      assert(recResult.verifiedStopped === true, 'must be verified stopped');

      // Verify backend state: run and task are done, lock released
      const updatedTask = getTaskById(backend.db, task.id);
      assert(updatedTask?.status === 'done', 'backend task must be done');
      assert(scheduler.getActiveRunCount() === 0, 'scheduler active runs must be 0');
    } finally {
      backend.cleanup();
    }
  },
);

// --- 30. Reconciler: Quarantines Runs Missing From Adapter ---
await check(
  'reconciler: marks missing/unreachable runs uncertain and quarantines lock',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t22_rec_missing');
      const repo = createRepository(backend.db, {
        name: 'repo_t22_rec_missing',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });
      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Reconciler Missing',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t22_recmiss' });
      const sched = await scheduler.scheduleNext();
      assert(sched.claimed, 'task must be claimed');

      const runId = sched.runId ?? '';
      const generation = sched.generation ?? 1;

      // Do NOT start the run on adapter, so adapter returns 404 for this runId
      const reconciler = new RunReconciler(bClient, aClient, scheduler, {
        ownerId: 'engine_t22_recmiss',
      });

      const recResult = await reconciler.reconcileRun(runId, generation);
      assert(recResult.reconciled === true, 'reconciliation must complete');
      assert(recResult.status === 'uncertain', 'status must be uncertain');
      assert(recResult.quarantined === true, 'lock must be quarantined');

      // Verify backend lock is quarantined
      const lock = backend.db
        .query('SELECT quarantined FROM run_locks WHERE working_tree_key = ?')
        .get(repo.canonicalPath) as { quarantined: number } | null;
      assert(lock?.quarantined === 1, 'tree must be quarantined');
    } finally {
      backend.cleanup();
    }
  },
);

// ============================================================================
// --- T23: Complete HITL Through Chat Checks ---
// ============================================================================
console.log('\n--- T23: Complete HITL Through Chat Checks ---');

// 1. Structured input reaches the right conversation and request
await check(
  'hitl: structured input_required event reaches conversation as agent message, sets pending request id, and pauses in hitl',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t23_structured');
      const repo = createRepository(backend.db, {
        name: 'repo_t23_structured',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Structured HITL Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t23_struct' });

      const sched = await scheduler.scheduleNext();
      assert(sched.claimed, 'task must be claimed');

      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t23_struct',
      });

      const dispatchRes = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          taskId: task.id,
          generation: sched.generation ?? 1,
          status: 'running',
          workingTreeKey: sched.workingTreeKey ?? '',
        },
        context,
        scenario: 'hitl',
      });

      assert(dispatchRes.status === 'hitl', 'dispatch status must be hitl');
      assert(scheduler.getActiveRunCount() === 1, 'scheduler lock must be retained during HITL');

      // Verify question message reached the conversation
      const msgRes = await bClient.getTaskMessages(task.id);
      assert(msgRes.messages.length >= 2, 'conversation must contain initial message and question');
      const questionMsg = msgRes.messages.find(
        (m) => m.content === 'Which environment should I target?',
      );
      assert(questionMsg !== undefined, 'question must be recorded in conversation');
      assert(questionMsg?.sender === 'agent', 'question sender must be agent');

      // Verify run status on backend
      const runStatus = await bClient.getRun(sched.runId ?? '');
      assert(runStatus.status === 'hitl', 'backend run status must be hitl');
      assert(runStatus.pendingInputRequestId === 'req_1', 'pendingInputRequestId must be req_1');

      // Verify task status
      const updatedTask = getTaskById(backend.db, task.id);
      assert(updatedTask?.status === 'hitl', 'task status must be hitl');
    } finally {
      backend.cleanup();
    }
  },
);

// 2. Reply safely resumes retained owner on adapter, completes, and finalizes with verified stopped proof
await check(
  'hitl: reply safely resumes retained owner on adapter, completes execution, and finalizes with verified stopped proof',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t23_resume');
      const repo = createRepository(backend.db, {
        name: 'repo_t23_resume',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Retained Resume Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t23_resume' });

      const sched = await scheduler.scheduleNext();
      assert(sched.claimed, 'task must be claimed');

      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t23_resume',
      });
      const coordinator = new HitlCoordinator(bClient, aClient, scheduler, dispatcher, {
        ownerId: 'engine_t23_resume',
      });

      // Dispatch to hitl state
      const initialDispatch = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          taskId: task.id,
          generation: sched.generation ?? 1,
          status: 'running',
          workingTreeKey: sched.workingTreeKey ?? '',
        },
        context,
        scenario: 'hitl',
      });
      assert(initialDispatch.status === 'hitl', 'must pause in hitl');

      // User submits reply via HitlCoordinator
      const userReply = 'Target the staging environment.';
      const conversationId = context.conversation?.id ?? '';
      const { message, dispatchResult } = await coordinator.handleReplyAndResume({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          generation: sched.generation ?? 1,
        },
        conversationId,
        requestId: 'req_1',
        response: userReply,
        scenario: 'hitl',
      });

      assert(message.content === userReply, 'returned message must match user reply');
      assert(message.inReplyToRequestId === 'req_1', 'message inReplyToRequestId must match');
      assert(dispatchResult.status === 'done', 'resumed run must complete with status done');
      assert(dispatchResult.verifiedStopped, 'completed run must be verified stopped');
      assert(scheduler.getActiveRunCount() === 0, 'scheduler lock must be released on completion');

      // Backend verification
      const updatedTask = getTaskById(backend.db, task.id);
      assert(updatedTask?.status === 'done', 'backend task status must be done');

      const finalRun = await bClient.getRun(sched.runId ?? '');
      assert(finalRun.status === 'done', 'backend run status must be done');
      assert(finalRun.pendingInputRequestId === null, 'pendingInputRequestId must be cleared');

      // Conversation must include the reply
      const msgRes = await bClient.getTaskMessages(task.id);
      const replyMsg = msgRes.messages.find((m) => m.content === userReply);
      assert(replyMsg !== undefined, 'reply message must be in conversation');
      assert(replyMsg?.sender === 'user', 'reply sender must be user');
    } finally {
      backend.cleanup();
    }
  },
);

// 3. Duplicate or stale reply with same inReplyToRequestId is rejected with 409 REQUEST_ALREADY_RESOLVED
await check(
  'hitl: duplicate or stale reply with same inReplyToRequestId is rejected with 409 REQUEST_ALREADY_RESOLVED without second resume',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t23_dup');
      const repo = createRepository(backend.db, {
        name: 'repo_t23_dup',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Duplicate HITL Reply Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t23_dup' });

      const sched = await scheduler.scheduleNext();
      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t23_dup',
      });
      const coordinator = new HitlCoordinator(bClient, aClient, scheduler, dispatcher, {
        ownerId: 'engine_t23_dup',
      });

      await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          taskId: task.id,
          generation: sched.generation ?? 1,
          status: 'running',
          workingTreeKey: sched.workingTreeKey ?? '',
        },
        context,
        scenario: 'hitl',
      });

      const conversationId = context.conversation?.id ?? '';

      // First reply succeeds
      await coordinator.submitReply(conversationId, 'Initial valid reply', 'req_1');

      // Duplicate reply with same inReplyToRequestId
      let duplicateCaught = false;
      try {
        await coordinator.submitReply(conversationId, 'Second duplicate reply', 'req_1');
      } catch (err: unknown) {
        if (err instanceof BackendClientError && err.status === 409) {
          duplicateCaught = true;
          assert(
            err.code === 'REQUEST_ALREADY_RESOLVED',
            'error code must be REQUEST_ALREADY_RESOLVED',
          );
        }
      }
      assert(duplicateCaught, 'duplicate reply must be rejected with 409 REQUEST_ALREADY_RESOLVED');

      // Stale nonexistent request ID is also rejected
      let staleCaught = false;
      try {
        await coordinator.submitReply(
          conversationId,
          'Nonexistent request reply',
          'req_nonexistent',
        );
      } catch (err: unknown) {
        if (err instanceof BackendClientError && err.status === 409) {
          staleCaught = true;
        }
      }
      assert(staleCaught, 'stale request reply must be rejected with 409');
    } finally {
      backend.cleanup();
    }
  },
);

// 4. Ordinary user message without inReplyToRequestId queues in conversation without resolving hitl
await check(
  'hitl: ordinary user message without inReplyToRequestId queues in conversation without resolving hitl',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t23_ordinary');
      const repo = createRepository(backend.db, {
        name: 'repo_t23_ordinary',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Ordinary Message Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t23_ord' });

      const sched = await scheduler.scheduleNext();
      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t23_ord',
      });
      const coordinator = new HitlCoordinator(bClient, aClient, scheduler, dispatcher, {
        ownerId: 'engine_t23_ord',
      });

      await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          taskId: task.id,
          generation: sched.generation ?? 1,
          status: 'running',
          workingTreeKey: sched.workingTreeKey ?? '',
        },
        context,
        scenario: 'hitl',
      });

      const conversationId = context.conversation?.id ?? '';

      // Post regular message without inReplyToRequestId
      const ordinaryMsg = await coordinator.submitReply(
        conversationId,
        'Just an informational comment while waiting',
      );
      assert(ordinaryMsg.inReplyToRequestId === null, 'inReplyToRequestId must be null');

      // Verify task and run are STILL in hitl status
      const updatedTask = getTaskById(backend.db, task.id);
      assert(updatedTask?.status === 'hitl', 'task must remain in hitl status');

      const runStatus = await bClient.getRun(sched.runId ?? '');
      assert(runStatus.status === 'hitl', 'run must remain in hitl status');
      assert(
        runStatus.pendingInputRequestId === 'req_1',
        'pendingInputRequestId must remain req_1',
      );
      assert(scheduler.getActiveRunCount() === 1, 'scheduler lock must remain held');
    } finally {
      backend.cleanup();
    }
  },
);

// 5. Ordinary chat text cannot approve provider tool permissions
await check('hitl: ordinary chat text cannot approve provider tool permissions', async () => {
  const backend = createTestBackend();
  const adapter = createTestAdapter();
  try {
    const bClient = backend.createClient();
    const aClient = adapter.createClient();
    const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t23_sec' });
    const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
      ownerId: 'engine_t23_sec',
    });
    const coordinator = new HitlCoordinator(bClient, aClient, scheduler, dispatcher, {
      ownerId: 'engine_t23_sec',
    });

    // Chat text can NEVER approve privileged permissions
    assert(
      coordinator.canApprovePrivilegedPermissions('yes') === false,
      'yes text cannot approve permissions',
    );
    assert(
      coordinator.canApprovePrivilegedPermissions('approve') === false,
      'approve text cannot approve permissions',
    );
    assert(
      coordinator.canApprovePrivilegedPermissions('sudo rm -rf /') === false,
      'privileged command text cannot approve permissions',
    );
    assert(
      coordinator.canApprovePrivilegedPermissions('{"type":"tool_approval","approved":true}') ===
        false,
      'fake JSON tool approval text cannot approve permissions',
    );
  } finally {
    backend.cleanup();
  }
});

// 6. Stop-and-resume model verifies process stopped before resume, uses declared capabilities (resume: true vs false)
await check(
  'hitl: stop-and-resume model verifies process stopped before resume, uses declared capabilities (resume: true vs false)',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_t23_stop_resume');
      const repo = createRepository(backend.db, {
        name: 'repo_t23_stop_resume',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Stop and Resume Test',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t23_sar' });

      const sched = await scheduler.scheduleNext();
      const context = await bClient.getTaskContext(task.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t23_sar',
      });

      // Dispatch to hitl state
      await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          taskId: task.id,
          generation: sched.generation ?? 1,
          status: 'running',
          workingTreeKey: sched.workingTreeKey ?? '',
        },
        context,
        scenario: 'hitl',
      });

      // Simulate adapter process having exited with verifiedStopped: true (stop-and-resume turn model)
      const adapterRun = adapter.manager.getRun(sched.runId ?? '');
      assert(adapterRun !== undefined, 'adapter run must exist');
      adapterRun.verifiedStoppedAt = new Date().toISOString();
      adapterRun.verificationMethod = 'process_group_empty';
      adapterRun.status = 'done'; // process stopped

      // Test Case A: Provider with resume: false (Codex baseline) -> uses fresh turn with folded context
      const resumeResult = await dispatcher.resumeHitlTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: sched.runId ?? '',
          generation: sched.generation ?? 1,
        },
        context,
        response: 'Use the production database replica.',
        requestId: 'req_1',
        provider: 'codex',
        scenario: 'success',
      });

      assert(resumeResult.status === 'done', 'resume turn must complete successfully');
      assert(resumeResult.verifiedStopped, 'must be verified stopped');
      assert(scheduler.getActiveRunCount() === 0, 'scheduler lock must be released');

      // Test Case B: Unverified stop blocks resume
      const task2 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Unverified Stop Test',
        priority: 'P1',
      });
      const sched2 = await scheduler.scheduleNext();
      const context2 = await bClient.getTaskContext(task2.id);

      await dispatcher.dispatchTask({
        task: task2 as unknown as TaskRecord,
        claim: {
          runId: sched2.runId ?? '',
          taskId: task2.id,
          generation: sched2.generation ?? 1,
          status: 'running',
          workingTreeKey: sched2.workingTreeKey ?? '',
        },
        context: context2,
        scenario: 'hitl',
      });

      // Force processState to report still running (not hitl, and not verified stopped)
      const adapterRun2 = adapter.manager.getRun(sched2.runId ?? '');
      assert(adapterRun2 !== undefined, 'run2 must exist');
      adapterRun2.status = 'running';
      adapterRun2.verifiedStoppedAt = null;

      const unverifiedResume = await dispatcher.resumeHitlTask({
        task: task2 as unknown as TaskRecord,
        claim: {
          runId: sched2.runId ?? '',
          generation: sched2.generation ?? 1,
        },
        context: context2,
        response: 'Some input',
        requestId: 'req_1',
        provider: 'codex',
      });

      assert(
        unverifiedResume.status === 'uncertain',
        'unverified stop must result in uncertain status',
      );
      assert(unverifiedResume.verifiedStopped === false, 'must not be verified stopped');

      // Working tree is quarantined to prevent duplicate writer
      const lockRow = backend.db
        .query('SELECT quarantined FROM run_locks WHERE working_tree_key = ?')
        .get(repo.canonicalPath) as { quarantined: number } | null;
      assert(lockRow?.quarantined === 1, 'working tree must be quarantined');
    } finally {
      backend.cleanup();
    }
  },
);

// 7. Working-tree lock is strictly retained through hitl pause and blocks concurrent claims
await check(
  'hitl: working-tree lock is strictly retained through hitl pause and blocks concurrent claims',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath1 = backend.createRepoDir('repo_t23_lock1');
      const repo1 = createRepository(backend.db, {
        name: 'repo_t23_lock1',
        displayPath: repoPath1,
        defaultProvider: 'codex',
      });

      const repoPath2 = backend.createRepoDir('repo_t23_lock2');
      const repo2 = createRepository(backend.db, {
        name: 'repo_t23_lock2',
        displayPath: repoPath2,
        defaultProvider: 'codex',
      });

      // Task 1 on repo 1 (P1)
      const task1 = createTask(backend.db, {
        repoId: repo1.id,
        title: 'Task 1 in HITL',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t23_lock' });

      // Claim and dispatch Task 1 to HITL
      const sched1 = await scheduler.scheduleNext();
      assert(sched1.claimed && sched1.taskId === task1.id, 'task 1 must be claimed');

      const context1 = await bClient.getTaskContext(task1.id);
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_t23_lock',
      });

      await dispatcher.dispatchTask({
        task: task1 as unknown as TaskRecord,
        claim: {
          runId: sched1.runId ?? '',
          taskId: task1.id,
          generation: sched1.generation ?? 1,
          status: 'running',
          workingTreeKey: sched1.workingTreeKey ?? '',
        },
        context: context1,
        scenario: 'hitl',
      });

      // Now create Task 2 (P0 emergency task on same busy tree) and Task 3 (P2 on distinct repo)
      const task2 = createTask(backend.db, {
        repoId: repo1.id,
        title: 'Task 2 P0 Waiting on Same Tree',
        priority: 'P0',
      });

      const task3 = createTask(backend.db, {
        repoId: repo2.id,
        title: 'Task 3 on Distinct Repo',
        priority: 'P2',
      });

      // Scheduler active run count is 1 (retained lock on repo 1)
      assert(scheduler.getActiveRunCount() === 1, 'scheduler lock must be held during HITL');

      // Next schedule call tries to schedule:
      // Even though Task 2 is P0, repo 1 is locked by Task 1 in HITL!
      // So Task 3 on repo 2 (idle tree) MUST be scheduled instead!
      const schedNext = await scheduler.scheduleNext();
      assert(schedNext.claimed, 'distinct repo task must be claimed');
      assert(
        schedNext.taskId === task3.id,
        'scheduler must claim task3 on repo 2, bypassing busy repo 1 even though task2 is P0',
      );

      // Verify that direct attempt to claim repo 1 task2 fails with LOCK_HELD
      let lockHeldCaught = false;
      try {
        await bClient.claimTask(task2.id, {
          ownerId: 'engine_t23_lock',
          generation: 1,
          idempotencyKey: 'manual_claim_task2',
        });
      } catch (err: unknown) {
        if (err instanceof BackendClientError && err.status === 409) {
          lockHeldCaught = true;
          assert(err.code === 'LOCK_HELD', 'error code must be LOCK_HELD');
        }
      }
      assert(lockHeldCaught, 'attempt to claim tree in HITL must fail with LOCK_HELD');
    } finally {
      backend.cleanup();
    }
  },
);

// --- T24: Parent/Child Delegation Checks ---
console.log('\n--- T24: Parent/Child Delegation Checks ---');

// 1. Managed agent receives scoped MCP credentials and creates bounded child task
await check(
  'delegation: managed agent receives scoped MCP credentials and creates bounded child task',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    const bClient = backend.createClient('engine');
    const aClient = adapter.createClient();
    const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t24_1' });

    try {
      const repoDir = backend.createRepoDir('delegation-repo-1');
      const repo = createRepository(backend.db, {
        name: 'delegation-repo-1',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      const parentTask = createTask(backend.db, {
        repoId: repo.id,
        title: 'Parent Task Architecture',
        priority: 'P1',
      });

      const sched = await scheduler.scheduleNext();
      assert(sched.claimed && sched.taskId === parentTask.id, 'parent task must be claimed');
      const parentRunId = sched.runId ?? '';

      // Mint managed MCP token via internal API
      const mcpTokenRes = await bClient.mintManagedMcpToken(parentRunId);
      assert(mcpTokenRes.token.length > 0, 'must mint non-empty managed token');

      // Call MCP create_task tool using the managed token
      const mcpRes = await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${mcpTokenRes.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'call_1',
            method: 'tools/call',
            params: {
              name: 'create_task',
              arguments: {
                title: 'Delegated Child 1',
                description: 'Implement auth module',
                priority: 'P1',
              },
            },
          }),
        }),
      );

      assert(mcpRes.status === 200, `MCP call must succeed, got ${mcpRes.status}`);
      const mcpData = (await mcpRes.json()) as {
        result: { content: [{ type: string; text: string }] };
      };
      const childData = JSON.parse(mcpData.result.content[0].text);
      assert(childData.id, 'child task must have an ID');
      assert(childData.parentId === parentTask.id, 'child parentId must match parent task ID');
      assert(childData.depth === 1, 'child task depth must be 1');
      assert(childData.repoId === repo.id, 'child repoId must match repo ID');
      assert(childData.status === 'todo', 'child task status must be todo');

      // Now test that a child task cannot create a grandchild
      // 0. Finalize parent run to release working tree lock
      await bClient.finalize(parentRunId, {
        ownerId: 'engine_t24_1',
        generation: sched.generation ?? 1,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });

      // 1. Claim child task
      const childClaim = await bClient.claimTask(childData.id, {
        ownerId: 'engine_t24_1',
        generation: sched.generation ?? 1,
        idempotencyKey: 'child_claim_1',
      });
      // 2. Mint managed token for child
      const childMcpRes = await bClient.mintManagedMcpToken(childClaim.runId);
      // 3. Child attempts to call create_task -> must fail
      const grandchildRes = await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${childMcpRes.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'call_gc',
            method: 'tools/call',
            params: {
              name: 'create_task',
              arguments: {
                title: 'Grandchild Task Attempt',
              },
            },
          }),
        }),
      );

      assert(grandchildRes.status === 400, 'grandchild creation must be rejected with 400');
      const errBody = (await grandchildRes.json()) as { code: string; message: string };
      assert(
        errBody.code === 'CHILD_LIMIT_EXCEEDED',
        `error code must be CHILD_LIMIT_EXCEEDED, got ${errBody.code}`,
      );
    } finally {
      backend.cleanup();
    }
  },
);

// 2. 5-child ceiling enforced per parent and idempotencyKey deduplicates child creation
await check(
  'delegation: 5-child ceiling enforced per parent and idempotencyKey deduplicates child creation',
  async () => {
    const backend = createTestBackend();
    const bClient = backend.createClient('engine');

    try {
      const repoDir = backend.createRepoDir('ceiling-repo');
      const repo = createRepository(backend.db, {
        name: 'ceiling-repo',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      const parentTask = createTask(backend.db, {
        repoId: repo.id,
        title: 'Parent with 5 Children Limit',
        priority: 'P1',
      });

      const claim = await bClient.claimTask(parentTask.id, {
        ownerId: 'engine_t24_2',
        generation: 0,
        idempotencyKey: 'parent_claim_2',
      });

      const mcpTokenRes = await bClient.mintManagedMcpToken(claim.runId);
      const token = mcpTokenRes.token;

      // 1. Create Child 1 with idempotencyKey
      const callCreate = async (idempKey: string, title = 'Child') => {
        return backend.app.fetch(
          new Request('http://127.0.0.1:9999/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'c',
              method: 'tools/call',
              params: {
                name: 'create_task',
                arguments: {
                  title,
                  idempotencyKey: idempKey,
                },
              },
            }),
          }),
        );
      };

      const res1 = await callCreate('idemp-1', 'Child 1');
      assert(res1.status === 200, 'first child creation must succeed');
      const data1 = (await res1.json()) as {
        result: { content: [{ type: string; text: string }] };
      };
      const child1 = JSON.parse(data1.result.content[0].text);

      // 2. Repeat call with same idempotencyKey -> must return identical child
      const res1Dup = await callCreate('idemp-1', 'Child 1 duplicate attempt');
      assert(res1Dup.status === 200, 'duplicate idempotency call must succeed');
      const data1Dup = (await res1Dup.json()) as {
        result: { content: [{ type: string; text: string }] };
      };
      const child1Dup = JSON.parse(data1Dup.result.content[0].text);
      assert(
        child1.id === child1Dup.id,
        'idempotent call must return the exact same child task ID',
      );

      // 3. Create children 2, 3, 4, 5
      for (let i = 2; i <= 5; i++) {
        const resI = await callCreate(`idemp-${i}`, `Child ${i}`);
        assert(resI.status === 200, `child ${i} creation must succeed`);
      }

      // 4. Attempt 6th child -> must be rejected with CHILD_LIMIT_EXCEEDED
      const res6 = await callCreate('idemp-6', 'Child 6');
      assert(res6.status === 400, '6th child creation must return 400');
      const err6 = (await res6.json()) as { code: string; message: string };
      assert(
        err6.code === 'CHILD_LIMIT_EXCEEDED',
        `error code must be CHILD_LIMIT_EXCEEDED, got ${err6.code}`,
      );
    } finally {
      backend.cleanup();
    }
  },
);

// 3. Explicit yield stops parent, releases lock, and sets block_kind to children
await check(
  'delegation: explicit yield stops parent, releases lock, and sets block_kind to children',
  async () => {
    const backend = createTestBackend();
    const bClient = backend.createClient('engine');

    try {
      const repoDir = backend.createRepoDir('yield-repo');
      const repo = createRepository(backend.db, {
        name: 'yield-repo',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      const parentTask = createTask(backend.db, {
        repoId: repo.id,
        title: 'Parent Task Yielding',
        priority: 'P1',
      });

      const claim = await bClient.claimTask(parentTask.id, {
        ownerId: 'engine_t24_3',
        generation: 0,
        idempotencyKey: 'claim_yield',
      });

      const mcpTokenRes = await bClient.mintManagedMcpToken(claim.runId);
      const token = mcpTokenRes.token;

      // Create child task C1 via MCP
      const createRes = await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'c1',
            method: 'tools/call',
            params: {
              name: 'create_task',
              arguments: { title: 'Child C1' },
            },
          }),
        }),
      );
      assert(createRes.status === 200, 'child creation must succeed');
      const createData = (await createRes.json()) as {
        result: { content: [{ type: string; text: string }] };
      };
      const childC1 = JSON.parse(createData.result.content[0].text);

      // Parent calls yield_task: this is intent, never proof of process exit.
      // It must NOT touch task/run/lock state yet.
      const yieldRes = await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'y1',
            method: 'tools/call',
            params: {
              name: 'yield_task',
              arguments: {
                childTaskIds: [childC1.id],
                reason: 'Waiting for Child C1 to complete',
              },
            },
          }),
        }),
      );
      assert(yieldRes.status === 200, `yield_task must succeed, got ${yieldRes.status}`);
      const yieldData = (await yieldRes.json()) as {
        result: { content: [{ type: string; text: string }] };
      };
      const yieldResult = JSON.parse(yieldData.result.content[0].text);
      assert(
        yieldResult.status === 'yield_requested',
        `expected yield_requested, got ${yieldResult.status}`,
      );

      // Ownership must still be held: parent stays processing, run stays
      // running, lock stays owned by this run (A4).
      const parentAfterIntent = getTaskById(backend.db, parentTask.id);
      assert(
        parentAfterIntent?.status === 'processing',
        `parent task must remain processing while yield is only intent, got ${parentAfterIntent?.status}`,
      );
      const runAfterIntent = backend.db
        .query('SELECT status FROM runs WHERE id = ?')
        .get(claim.runId) as { status: string };
      assert(runAfterIntent.status === 'running', 'run must remain running while yield is intent');
      const lockAfterIntent = backend.db
        .query('SELECT owner_run_id FROM run_locks WHERE working_tree_key = ?')
        .get(repo.canonicalPath) as { owner_run_id: string };
      assert(
        lockAfterIntent.owner_run_id === claim.runId,
        'lock must still be held by the parent run while yield is intent',
      );

      // Only now — trusted adapter stop evidence via the same finalize path
      // the engine itself uses — may release the lock and block the parent.
      await bClient.finalize(claim.runId, {
        ownerId: 'engine_t24_3',
        generation: claim.generation,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });

      const parentAfterYield = getTaskById(backend.db, parentTask.id);
      assert(parentAfterYield !== null, 'parent task must exist');
      assert(parentAfterYield.status === 'todo', 'parent task status must be todo after yield');
      assert(
        parentAfterYield.blockKind === 'children',
        `parent blockKind must be 'children', got ${parentAfterYield.blockKind}`,
      );
      assert(
        parentAfterYield.blockedReason === 'Waiting for Child C1 to complete',
        'blockedReason must match yield reason',
      );
      assert(
        Boolean(parentAfterYield.blockedOnChildIds?.includes(childC1.id)),
        'blockedOnChildIds must contain child C1 ID',
      );

      // Verify parent run in DB
      const runRow = backend.db
        .query('SELECT status, ended_at FROM runs WHERE id = ?')
        .get(claim.runId) as { status: string; ended_at: string | null };
      assert(runRow.status === 'done', 'run status must be done');
      assert(runRow.ended_at !== null, 'run ended_at must be recorded');

      // Verify working tree lock is released
      const lockRow = backend.db
        .query('SELECT owner_run_id, generation FROM run_locks WHERE working_tree_key = ?')
        .get(repo.canonicalPath) as { owner_run_id: string; generation: number };
      assert(lockRow.owner_run_id === '', 'lock owner must be released');
      assert(lockRow.generation === claim.generation, 'lock generation must be preserved');

      // A repeated finalize call (idempotency guard) must not re-run side
      // effects or throw.
      await bClient.finalize(claim.runId, {
        ownerId: 'engine_t24_3',
        generation: claim.generation,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });

      const parentAfterFinalize = getTaskById(backend.db, parentTask.id);
      assert(
        parentAfterFinalize?.status === 'todo',
        'parent task status must remain todo and NOT be overwritten to done',
      );
      assert(
        parentAfterFinalize?.blockKind === 'children',
        'parent task blockKind must remain children',
      );
    } finally {
      backend.cleanup();
    }
  },
);

// 4. yield_task requires verified stop proof, valid children, and managed scope
await check(
  'delegation: yield_task requires verified stop proof, valid children, and managed scope',
  async () => {
    const backend = createTestBackend();
    const bClient = backend.createClient('engine');

    try {
      const repoDir = backend.createRepoDir('yield-guards-repo');
      const repo = createRepository(backend.db, {
        name: 'yield-guards-repo',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      const parentTask = createTask(backend.db, {
        repoId: repo.id,
        title: 'Parent for Guard Tests',
        priority: 'P1',
      });

      const claim = await bClient.claimTask(parentTask.id, {
        ownerId: 'engine_t24_4',
        generation: 0,
        idempotencyKey: 'claim_guards',
      });

      const mcpTokenRes = await bClient.mintManagedMcpToken(claim.runId);
      const token = mcpTokenRes.token;

      // Case A: Parent has NO children -> yield_task must fail with VALIDATION_ERROR
      const yieldNoChildren = await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'y_none',
            method: 'tools/call',
            params: {
              name: 'yield_task',
              arguments: {},
            },
          }),
        }),
      );
      assert(yieldNoChildren.status === 400, 'yield without children must return 400');

      // Create a valid child
      const child = createTask(backend.db, {
        repoId: repo.id,
        title: 'Child 1',
        priority: 'P1',
        parentId: parentTask.id,
      });

      // Case B: Passing a child ID that belongs to another parent -> 403 FORBIDDEN
      const otherParent = createTask(backend.db, {
        repoId: repo.id,
        title: 'Other Parent',
        priority: 'P1',
      });
      const otherChild = createTask(backend.db, {
        repoId: repo.id,
        title: 'Other Child',
        priority: 'P1',
        parentId: otherParent.id,
      });

      const yieldAlienChild = await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'y_alien',
            method: 'tools/call',
            params: {
              name: 'yield_task',
              arguments: { childTaskIds: [otherChild.id] },
            },
          }),
        }),
      );
      assert(yieldAlienChild.status === 403, 'yielding for non-child must return 403');

      // Case C: a forged `x-verified-stopped: true` header must NOT attest
      // process exit — yield_task always returns yield_requested and leaves
      // ownership untouched, regardless of any client-supplied header.
      const yieldForgedHeader = await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'x-verified-stopped': 'true',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'y_forged',
            method: 'tools/call',
            params: {
              name: 'yield_task',
              arguments: { childTaskIds: [child.id] },
            },
          }),
        }),
      );
      assert(yieldForgedHeader.status === 200, 'yield_task must accept the request (it is intent)');
      const forgedData = (await yieldForgedHeader.json()) as {
        result: { content: [{ type: string; text: string }] };
      };
      const forgedResult = JSON.parse(forgedData.result.content[0].text);
      assert(
        forgedResult.status === 'yield_requested',
        `forged x-verified-stopped:true must not produce a terminal status, got ${forgedResult.status}`,
      );
      const parentAfterForged = getTaskById(backend.db, parentTask.id);
      assert(
        parentAfterForged?.status === 'processing',
        'a forged verified-stopped header must not release the lock or change task status',
      );

      // Only the trusted internal finalize path (verified adapter stop
      // evidence) can actually complete the handoff.
      await bClient.finalize(claim.runId, {
        ownerId: 'engine_t24_4',
        generation: claim.generation,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });
      const parentAfterTrustedFinalize = getTaskById(backend.db, parentTask.id);
      assert(
        parentAfterTrustedFinalize?.status === 'todo' &&
          parentAfterTrustedFinalize.blockKind === 'children',
        'trusted finalize must be the only path that blocks the parent on children',
      );
    } finally {
      backend.cleanup();
    }
  },
);

// 5. Same-tree delegation cannot deadlock on retained parent writer
await check(
  'delegation: same-tree delegation cannot deadlock on retained parent writer',
  async () => {
    const backend = createTestBackend();
    const bClient = backend.createClient('engine');
    const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t24_5' });

    try {
      const repoDir = backend.createRepoDir('deadlock-free-repo');
      const repo = createRepository(backend.db, {
        name: 'deadlock-free-repo',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      // 1. Create parent task on repo
      const parentTask = createTask(backend.db, {
        repoId: repo.id,
        title: 'Parent Task On Same Repo',
        priority: 'P1',
      });

      // 2. Scheduler claims parent task
      const parentSched = await scheduler.scheduleNext();
      assert(parentSched.claimed, 'parent must be claimed');
      assert(parentSched.taskId === parentTask.id, 'parent task claimed');
      assert(scheduler.isTreeBusy(repo.canonicalPath), 'tree must be locked by parent');

      // 3. Create child task on the SAME repo
      const childTask = createTask(backend.db, {
        repoId: repo.id,
        title: 'Child Task On Same Repo',
        priority: 'P0', // Child is higher priority!
        parentId: parentTask.id,
      });

      // 4. Parent yields via MCP
      const parentRunId = parentSched.runId ?? '';
      const mcpTokenRes = await bClient.mintManagedMcpToken(parentRunId);
      const yieldRes = await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${mcpTokenRes.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'y_dt',
            method: 'tools/call',
            params: {
              name: 'yield_task',
              arguments: { childTaskIds: [childTask.id] },
            },
          }),
        }),
      );
      assert(yieldRes.status === 200, 'yield must succeed');

      // yield_task is intent only: the backend lock is still held by the
      // parent run until trusted adapter stop evidence finalizes it.
      await bClient.finalize(parentRunId, {
        ownerId: 'engine_t24_5',
        generation: parentSched.generation ?? 1,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });

      // Engine releases the parent run from scheduler
      scheduler.releaseRun(parentRunId);

      // 5. Next schedule tick:
      // - Parent is 'todo' but has block_kind = 'children' -> NOT runnable!
      // - Child is 'todo' on the SAME repo -> lock is FREE!
      // - Scheduler MUST claim child task on same repo! NO DEADLOCK!
      const childSched = await scheduler.scheduleNext();
      assert(childSched.claimed, 'child task on same tree must be claimed without deadlock');
      assert(childSched.taskId === childTask.id, 'child task must be claimed');
      assert(
        (childSched.generation ?? 0) > (parentSched.generation ?? 0),
        'child generation must increment',
      );
      assert(scheduler.isTreeBusy(repo.canonicalPath), 'child now holds the lock on same tree');

      // Further schedule call returns nothing runnable (parent still blocked on child)
      const nextSched = await scheduler.scheduleNext();
      assert(!nextSched.claimed, 'parent must not be claimed while child is running');
    } finally {
      backend.cleanup();
    }
  },
);

// 6. Parent waits for all children and unblocks only when all succeed
await check(
  'delegation: parent waits for all children and unblocks only when all succeed',
  async () => {
    const backend = createTestBackend();
    const bClient = backend.createClient('engine');
    const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t24_6' });

    try {
      const repoDir = backend.createRepoDir('multi-child-success-repo');
      const repo = createRepository(backend.db, {
        name: 'multi-child-success-repo',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      // 1. Create parent task
      const parentTask = createTask(backend.db, {
        repoId: repo.id,
        title: 'Parent Task With 2 Children',
        priority: 'P2',
      });

      // 2. Claim parent and yield waiting for 2 children
      const parentClaim = await bClient.claimTask(parentTask.id, {
        ownerId: 'engine_t24_6',
        generation: 0,
        idempotencyKey: 'p_claim_wait',
      });

      const child1 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Child 1 Parser',
        priority: 'P1',
        parentId: parentTask.id,
      });
      const child2 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Child 2 Renderer',
        priority: 'P1',
        parentId: parentTask.id,
      });

      const mcpTokenRes = await bClient.mintManagedMcpToken(parentClaim.runId);
      await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${mcpTokenRes.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'y_all',
            method: 'tools/call',
            params: {
              name: 'yield_task',
              arguments: { childTaskIds: [child1.id, child2.id] },
            },
          }),
        }),
      );

      // yield_task is intent only: trusted finalize (real adapter stop
      // evidence) is what actually releases the lock and blocks the parent.
      await bClient.finalize(parentClaim.runId, {
        ownerId: 'engine_t24_6',
        generation: parentClaim.generation,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });

      // Verify parent is blocked
      const pBlocked = getTaskById(backend.db, parentTask.id);
      assert(pBlocked?.blockKind === 'children', 'parent must be blocked on children');

      // 3. Child 1 is claimed and completes with 'done'
      const c1Claim = await bClient.claimTask(child1.id, {
        ownerId: 'engine_t24_6',
        generation: parentClaim.generation,
        idempotencyKey: 'c1_claim',
      });
      await bClient.finalize(c1Claim.runId, {
        ownerId: 'engine_t24_6',
        generation: c1Claim.generation,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
        summary: 'Parser completed successfully',
      });

      // Verify parent is STILL blocked (Child 2 is not yet terminal)
      const runnableMid = await bClient.listRunnableTasks();
      const parentInMid = runnableMid.find((t) => t.id === parentTask.id);
      assert(!parentInMid, 'parent must still be blocked while child 2 is not terminal');

      // 4. Child 2 is claimed and completes with 'done'
      const c2Claim = await bClient.claimTask(child2.id, {
        ownerId: 'engine_t24_6',
        generation: c1Claim.generation,
        idempotencyKey: 'c2_claim',
      });
      await bClient.finalize(c2Claim.runId, {
        ownerId: 'engine_t24_6',
        generation: c2Claim.generation,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
        summary: 'Renderer completed successfully',
      });

      // 5. All children are done!
      // Parent must now be unblocked!
      const parentUnblocked = getTaskById(backend.db, parentTask.id);
      assert(parentUnblocked?.status === 'todo', 'parent status must be todo after unblocking');
      assert(
        parentUnblocked?.blockKind === null,
        `parent blockKind must be cleared (null), got ${parentUnblocked?.blockKind}`,
      );
      assert(
        parentUnblocked?.blockedReason === null,
        'parent blockedReason must be cleared (null)',
      );

      // 6. Scheduler can now claim parent task with new runId and incremented generation!
      const resumedClaim = await scheduler.scheduleNext();
      assert(resumedClaim.claimed, 'resumed parent must be claimed by scheduler');
      assert(resumedClaim.taskId === parentTask.id, 'claimed task must be parent');
      assert(resumedClaim.runId !== parentClaim.runId, 'resumed claim must have new runId');
      assert(
        (resumedClaim.generation ?? 0) > c2Claim.generation,
        'resumed generation must increment',
      );

      // 7. Instruction context contains structured child task summaries
      const context = await bClient.getTaskContext(parentTask.id);
      assert(
        Boolean(context.children && context.children.length === 2),
        'context must contain 2 child summaries',
      );
      const c1Summary = context.children?.find((c) => c.id === child1.id);
      assert(c1Summary?.status === 'done', 'child 1 status must be done');
      assert(c1Summary?.summary === 'Parser completed successfully', 'child 1 summary must match');

      const instruction = buildInstruction(context);
      assert(
        instruction.includes('## Delegated Child Tasks Results'),
        'instruction must include child tasks results header',
      );
      assert(
        instruction.includes('Parser completed successfully'),
        'instruction must include child 1 summary',
      );
      assert(
        instruction.includes('Renderer completed successfully'),
        'instruction must include child 2 summary',
      );
      assert(
        !instruction.includes('### Child Task Failures / Cancellations'),
        'instruction must not report failures when all succeeded',
      );
    } finally {
      backend.cleanup();
    }
  },
);

// 7. Parent stays blocked if any child fails or is cancelled with user-visible reason
await check(
  'delegation: parent stays blocked if any child fails or is cancelled with user-visible reason',
  async () => {
    const backend = createTestBackend();
    const bClient = backend.createClient('engine');
    const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_t24_7' });

    try {
      const repoDir = backend.createRepoDir('child-failure-repo');
      const repo = createRepository(backend.db, {
        name: 'child-failure-repo',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      const parentTask = createTask(backend.db, {
        repoId: repo.id,
        title: 'Parent Task With Failing Child',
        priority: 'P1',
      });

      const parentClaim = await bClient.claimTask(parentTask.id, {
        ownerId: 'engine_t24_7',
        generation: 0,
        idempotencyKey: 'p_claim_fail',
      });

      const child1 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Child 1 Success',
        priority: 'P1',
        parentId: parentTask.id,
      });
      const child2 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Child 2 Failure',
        priority: 'P1',
        parentId: parentTask.id,
      });

      const mcpTokenRes = await bClient.mintManagedMcpToken(parentClaim.runId);
      await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${mcpTokenRes.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'y_fail',
            method: 'tools/call',
            params: {
              name: 'yield_task',
              arguments: { childTaskIds: [child1.id, child2.id] },
            },
          }),
        }),
      );

      // yield_task is intent only: trusted finalize is what actually
      // releases the lock and blocks the parent on children.
      await bClient.finalize(parentClaim.runId, {
        ownerId: 'engine_t24_7',
        generation: parentClaim.generation,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });

      // Child 1 completes successfully
      const c1Claim = await bClient.claimTask(child1.id, {
        ownerId: 'engine_t24_7',
        generation: parentClaim.generation,
        idempotencyKey: 'c1_claim_ok',
      });
      await bClient.finalize(c1Claim.runId, {
        ownerId: 'engine_t24_7',
        generation: c1Claim.generation,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
        summary: 'Child 1 succeeded',
      });

      // Child 2 fails!
      const c2Claim = await bClient.claimTask(child2.id, {
        ownerId: 'engine_t24_7',
        generation: c1Claim.generation,
        idempotencyKey: 'c2_claim_err',
      });
      await bClient.finalize(c2Claim.runId, {
        ownerId: 'engine_t24_7',
        generation: c2Claim.generation,
        status: 'error',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
        errorMessage: 'Database connection failed during migration',
      });

      // Check parent task state: MUST STAY BLOCKED!
      const parentAfterFail = getTaskById(backend.db, parentTask.id);
      assert(parentAfterFail !== null, 'parent task must exist');
      assert(
        parentAfterFail.blockKind === 'children',
        `parent blockKind must remain children, got ${parentAfterFail.blockKind}`,
      );
      assert(parentAfterFail.status === 'todo', 'parent status must remain todo');
      assert(
        Boolean(parentAfterFail.blockedReason?.includes('Child task failed or cancelled')),
        `blockedReason must describe child failure, got: ${parentAfterFail.blockedReason}`,
      );
      assert(
        Boolean(
          parentAfterFail.blockedReason?.includes('Database connection failed during migration'),
        ),
        'blockedReason must include child error details',
      );

      // Scheduler must NOT claim parent task
      const schedAttempt = await scheduler.scheduleNext();
      assert(!schedAttempt.claimed, 'parent must not be claimed automatically on child failure');

      // Verify instruction context formats the failure prominently when inspected
      const context = await bClient.getTaskContext(parentTask.id);
      const instruction = buildInstruction(context);
      assert(
        instruction.includes('### Child Task Failures / Cancellations'),
        'instruction must include child task failures header',
      );
      assert(
        instruction.includes('Database connection failed during migration'),
        'instruction must include error message',
      );
    } finally {
      backend.cleanup();
    }
  },
);

console.log('\n--- T25: End-to-End Execution Safety & Both-Provider Checks ---');

// 1. Serialized same-tree writes: 2 tasks on same repo executed strictly sequentially
await check(
  'e2e safety: serialized same-tree writes enforce strict sequential execution without overlapping writers',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoPath = backend.createRepoDir('repo_e2e_seq');
      const repo = createRepository(backend.db, {
        name: 'repo_e2e_seq',
        displayPath: repoPath,
        defaultProvider: 'codex',
      });

      const t1 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task 1 First',
        priority: 'P0',
      });
      const t2 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task 2 Second',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, {
        ownerId: 'engine_e2e_seq',
        maxConcurrency: 5,
      });
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_e2e_seq',
      });

      // Claim Task 1
      const step1 = await scheduler.scheduleNext();
      assert(step1.claimed === true, 'step1 must claim task');
      assert(step1.taskId === t1.id, 'step1 must claim P0 task first');
      assert(scheduler.isTreeBusy(repo.canonicalPath), 'working tree must be busy');

      // While Task 1 is active, attempt to schedule next task
      const step2 = await scheduler.scheduleNext();
      assert(!step2.claimed, 'step2 must NOT claim while Task 1 is active');
      assert(step2.skippedReason === 'all_trees_busy', 'skipped reason must be all_trees_busy');

      // Direct backend claim attempt must also be rejected with 409 LOCK_HELD
      let directClaimBlocked = false;
      try {
        await bClient.claimTask(t2.id, {
          ownerId: 'engine_e2e_seq',
          generation: step1.generation ?? 1,
          idempotencyKey: 'direct_claim_attempt',
        });
      } catch (err: unknown) {
        if (err instanceof BackendClientError && err.status === 409) {
          directClaimBlocked = true;
        }
      }
      assert(directClaimBlocked, 'direct backend claim on busy tree must be rejected with 409');

      // Dispatch Task 1 to completion
      const ctx1 = await bClient.getTaskContext(t1.id);
      const res1 = await dispatcher.dispatchTask({
        task: t1 as unknown as TaskRecord,
        claim: {
          runId: step1.runId ?? '',
          taskId: t1.id,
          generation: step1.generation ?? 1,
          status: 'running',
          workingTreeKey: step1.workingTreeKey ?? '',
        },
        context: ctx1,
        scenario: 'success',
      });
      assert(res1.status === 'done', 'task 1 must complete to done');
      assert(res1.verifiedStopped, 'task 1 must have verified stop proof');
      assert(
        !scheduler.isTreeBusy(repo.canonicalPath),
        'working tree must be released after completion',
      );

      // Now Task 2 can be claimed
      const step3 = await scheduler.scheduleNext();
      assert(step3.claimed === true, 'step3 must claim task 2 now that tree is released');
      assert(step3.taskId === t2.id, 'step3 must claim task 2');
      assert(
        (step3.generation ?? 0) > (step1.generation ?? 0),
        'generation must increment monotonically',
      );

      const ctx2 = await bClient.getTaskContext(t2.id);
      const res2 = await dispatcher.dispatchTask({
        task: t2 as unknown as TaskRecord,
        claim: {
          runId: step3.runId ?? '',
          taskId: t2.id,
          generation: step3.generation ?? 2,
          status: 'running',
          workingTreeKey: step3.workingTreeKey ?? '',
        },
        context: ctx2,
        scenario: 'success',
      });
      assert(res2.status === 'done', 'task 2 must complete to done');
      assert(res2.verifiedStopped, 'task 2 must have verified stop proof');

      // Verify final state in DB
      const dbTask1 = getTaskById(backend.db, t1.id);
      const dbTask2 = getTaskById(backend.db, t2.id);
      assert(dbTask1?.status === 'done', 'task 1 in DB must be done');
      assert(dbTask2?.status === 'done', 'task 2 in DB must be done');
    } finally {
      backend.cleanup();
    }
  },
);

// 2. Parallel distinct repos: tasks on distinct repos run concurrently up to limit
await check(
  'e2e safety: parallel execution on distinct repositories runs concurrently up to limit',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoDir1 = backend.createRepoDir('repo_e2e_p1');
      const repoDir2 = backend.createRepoDir('repo_e2e_p2');
      const repo1 = createRepository(backend.db, {
        name: 'repo_e2e_p1',
        displayPath: repoDir1,
        defaultProvider: 'codex',
      });
      const repo2 = createRepository(backend.db, {
        name: 'repo_e2e_p2',
        displayPath: repoDir2,
        defaultProvider: 'claude',
      });

      const t1 = createTask(backend.db, {
        repoId: repo1.id,
        title: 'Task on Repo 1',
        priority: 'P1',
      });
      const t2 = createTask(backend.db, {
        repoId: repo2.id,
        title: 'Task on Repo 2',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, {
        ownerId: 'engine_e2e_par',
        maxConcurrency: 5,
      });
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_e2e_par',
      });

      // Claim Task 1
      const claim1 = await scheduler.scheduleNext();
      assert(claim1.claimed === true, 'claim1 must succeed');

      // Claim Task 2 concurrently
      const claim2 = await scheduler.scheduleNext();
      assert(claim2.claimed === true, 'claim2 must succeed concurrently on distinct tree');

      // Both trees must be busy simultaneously
      assert(scheduler.isTreeBusy(repo1.canonicalPath), 'tree 1 must be busy');
      assert(scheduler.isTreeBusy(repo2.canonicalPath), 'tree 2 must be busy');

      const firstTask = claim1.taskId === t1.id ? t1 : t2;
      const secondTask = claim1.taskId === t1.id ? t2 : t1;
      const ctx1 = await bClient.getTaskContext(firstTask.id);
      const ctx2 = await bClient.getTaskContext(secondTask.id);

      const [res1, res2] = await Promise.all([
        dispatcher.dispatchTask({
          task: firstTask as unknown as TaskRecord,
          claim: {
            runId: claim1.runId ?? '',
            taskId: firstTask.id,
            generation: claim1.generation ?? 1,
            status: 'running',
            workingTreeKey: claim1.workingTreeKey ?? '',
          },
          context: ctx1,
          scenario: 'success',
        }),
        dispatcher.dispatchTask({
          task: secondTask as unknown as TaskRecord,
          claim: {
            runId: claim2.runId ?? '',
            taskId: secondTask.id,
            generation: claim2.generation ?? 1,
            status: 'running',
            workingTreeKey: claim2.workingTreeKey ?? '',
          },
          context: ctx2,
          scenario: 'success',
        }),
      ]);

      assert(res1.status === 'done', 'task 1 must complete');
      assert(res2.status === 'done', 'task 2 must complete');
      assert(!scheduler.isTreeBusy(repo1.canonicalPath), 'tree 1 must be released');
      assert(!scheduler.isTreeBusy(repo2.canonicalPath), 'tree 2 must be released');
    } finally {
      backend.cleanup();
    }
  },
);

// 3. HITL end-to-end: question, pause with lock retention, chat reply, and safe resume to completion
await check(
  'e2e safety: HITL question, pause with lock retention, chat reply, and safe resume to completion',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoDir = backend.createRepoDir('repo_e2e_hitl');
      const repo = createRepository(backend.db, {
        name: 'repo_e2e_hitl',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task HITL E2E',
        priority: 'P0',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_e2e_hitl' });
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_e2e_hitl',
      });

      const claim = await scheduler.scheduleNext();
      assert(claim.claimed === true, 'claim must succeed');

      const ctx = await bClient.getTaskContext(task.id);

      // Dispatch task with 'hitl' scenario: emits input_required and pauses
      const hitlRes = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: claim.runId ?? '',
          taskId: task.id,
          generation: claim.generation ?? 1,
          status: 'running',
          workingTreeKey: claim.workingTreeKey ?? '',
        },
        context: ctx,
        scenario: 'hitl',
      });

      assert(hitlRes.status === 'hitl', 'dispatch result must be hitl');

      // Inspect DB state: task and run are in hitl
      const dbTask = getTaskById(backend.db, task.id);
      assert(dbTask?.status === 'hitl', 'db task must be hitl');
      const runStatus = await bClient.getRun(claim.runId ?? '');
      assert(runStatus.status === 'hitl', 'backend run status must be hitl');
      assert(runStatus.pendingInputRequestId === 'req_1', 'pendingInputRequestId must match');

      // Working tree lock MUST BE RETAINED during hitl pause
      assert(scheduler.isTreeBusy(repo.canonicalPath), 'tree must remain busy during HITL');

      const tSecond = createTask(backend.db, {
        repoId: repo.id,
        title: 'Second Task',
        priority: 'P0',
      });
      const schedBlocked = await scheduler.scheduleNext();
      assert(!schedBlocked.claimed, 'scheduler must not claim while task is in hitl');

      let directBlocked = false;
      try {
        await bClient.claimTask(tSecond.id, {
          ownerId: 'engine_e2e_hitl',
          generation: 1,
          idempotencyKey: 'hitl_concurrent_attempt',
        });
      } catch (err: unknown) {
        if (err instanceof BackendClientError && err.status === 409) {
          directBlocked = true;
        }
      }
      assert(directBlocked, 'direct claim must be blocked with 409 while tree is in HITL');

      // Human replies in chat
      const replyRes = await backend.app.fetch(
        new Request(`http://127.0.0.1:9999/api/tasks/${task.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: 'Target staging environment.',
            inReplyToRequestId: 'req_1',
          }),
        }),
      );
      assert(replyRes.status === 201, 'chat reply must be created');

      // Resume execution via HitlCoordinator / dispatcher
      const updatedCtx = await bClient.getTaskContext(task.id);
      const resumeRes = await dispatcher.resumeHitlTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: claim.runId ?? '',
          taskId: task.id,
          generation: claim.generation ?? 1,
          status: 'running',
          workingTreeKey: claim.workingTreeKey ?? '',
        },
        context: updatedCtx,
        requestId: 'req_1',
        response: 'Target staging environment.',
      });

      assert(resumeRes.status === 'done', 'resumed run must complete to done');
      assert(resumeRes.verifiedStopped, 'resumed run must have verified stopped proof');

      // Tree is released after completion
      assert(!scheduler.isTreeBusy(repo.canonicalPath), 'tree must be released after completion');
      const finalTask = getTaskById(backend.db, task.id);
      assert(finalTask?.status === 'done', 'final task must be done');
    } finally {
      backend.cleanup();
    }
  },
);

// 4. Parent/Child round-trip end-to-end: yield, child execution, and automatic parent unblock
await check(
  'e2e safety: parent task child delegation, yield lock release, child execution, and automatic parent unblock',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoDir = backend.createRepoDir('repo_e2e_del');
      const repo = createRepository(backend.db, {
        name: 'repo_e2e_del',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      const parentTask = createTask(backend.db, {
        repoId: repo.id,
        title: 'Parent Task',
        priority: 'P0',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_e2e_del' });
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_e2e_del',
      });

      // Claim parent task
      const parentClaim = await scheduler.scheduleNext();
      assert(parentClaim.claimed === true, 'parent must be claimed');

      // Mint managed MCP token
      const mcpToken = await bClient.mintManagedMcpToken(parentClaim.runId ?? '');

      // Parent creates child task via MCP
      const createChildRes = await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${mcpToken.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'call_1',
            method: 'tools/call',
            params: {
              name: 'create_task',
              arguments: {
                title: 'Child Task Worker',
                priority: 'P1',
                repoId: repo.id,
                idempotencyKey: 'child_worker_1',
              },
            },
          }),
        }),
      );
      const childData = (await createChildRes.json()) as {
        result: { content: Array<{ text: string }> };
      };
      const childTaskInfo = JSON.parse(childData.result.content[0].text);
      const childTaskId = childTaskInfo.id;

      // Parent yields to child via MCP
      const yieldRes = await backend.app.fetch(
        new Request('http://127.0.0.1:9999/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${mcpToken.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'call_2',
            method: 'tools/call',
            params: {
              name: 'yield_task',
              arguments: {
                childTaskIds: [childTaskId],
                reason: 'Waiting for child worker',
              },
            },
          }),
        }),
      );
      assert(yieldRes.status === 200, 'yield_task must succeed');

      // yield_task is intent only: trusted finalize (real adapter stop
      // evidence) is what actually releases the lock and blocks the parent.
      await bClient.finalize(parentClaim.runId ?? '', {
        ownerId: 'engine_e2e_del',
        generation: parentClaim.generation ?? 1,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });

      // Parent task state is now todo with block_kind = 'children'
      const parentDb = getTaskById(backend.db, parentTask.id);
      assert(parentDb?.blockKind === 'children', 'parent blockKind must be children');
      scheduler.releaseRun(parentClaim.runId ?? '');

      // Working tree lock is released! Child can now be claimed on the SAME tree without deadlock
      const childClaim = await scheduler.scheduleNext();
      assert(childClaim.claimed === true, 'child task must be claimed on same tree');
      assert(childClaim.taskId === childTaskId, 'claimed task must be the child task');

      // Dispatch child task to completion
      const childCtx = await bClient.getTaskContext(childTaskId);
      const childRes = await dispatcher.dispatchTask({
        task: childTaskInfo as unknown as TaskRecord,
        claim: {
          runId: childClaim.runId ?? '',
          taskId: childTaskId,
          generation: childClaim.generation ?? 2,
          status: 'running',
          workingTreeKey: childClaim.workingTreeKey ?? '',
        },
        context: childCtx,
        scenario: 'success',
      });
      assert(childRes.status === 'done', 'child task must complete to done');

      // Child is done -> parent must be automatically unblocked and claimed
      const parentResumedClaim = await scheduler.scheduleNext();
      assert(
        parentResumedClaim.claimed === true,
        'parent task must be automatically claimed after child completes',
      );
      assert(
        parentResumedClaim.taskId === parentTask.id,
        'claimed task must be the resumed parent',
      );

      const parentCtx = await bClient.getTaskContext(parentTask.id);
      const parentRes = await dispatcher.dispatchTask({
        task: parentDb as unknown as TaskRecord,
        claim: {
          runId: parentResumedClaim.runId ?? '',
          taskId: parentTask.id,
          generation: parentResumedClaim.generation ?? 3,
          status: 'running',
          workingTreeKey: parentResumedClaim.workingTreeKey ?? '',
        },
        context: parentCtx,
        scenario: 'success',
      });
      assert(parentRes.status === 'done', 'resumed parent must complete to done');

      const finalParent = getTaskById(backend.db, parentTask.id);
      const finalChild = getTaskById(backend.db, childTaskId);
      assert(finalParent?.status === 'done', 'final parent must be done');
      assert(finalChild?.status === 'done', 'final child must be done');
    } finally {
      backend.cleanup();
    }
  },
);

// 5. Explicit retry: failed run releases lock cleanly and explicit retry succeeds under incremented generation
await check(
  'e2e safety: failed run releases lock cleanly and explicit retry succeeds under incremented generation',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoDir = backend.createRepoDir('repo_e2e_retry');
      const repo = createRepository(backend.db, {
        name: 'repo_e2e_retry',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Fails First',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_e2e_retry' });
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_e2e_retry',
      });

      // Claim Task 1
      const claim1 = await scheduler.scheduleNext();
      assert(claim1.claimed === true, 'claim 1 must succeed');

      // Dispatch with failure scenario
      const ctx1 = await bClient.getTaskContext(task.id);
      const failRes = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: claim1.runId ?? '',
          taskId: task.id,
          generation: claim1.generation ?? 1,
          status: 'running',
          workingTreeKey: claim1.workingTreeKey ?? '',
        },
        context: ctx1,
        scenario: 'failure',
      });

      assert(failRes.status === 'error', 'run must end in error');
      assert(failRes.verifiedStopped, 'failed run must have verified stop proof');
      assert(
        !scheduler.isTreeBusy(repo.canonicalPath),
        'tree must be released on clean error finalization',
      );

      // Scheduler will not claim error task
      const schedBlocked = await scheduler.scheduleNext();
      assert(!schedBlocked.claimed, 'scheduler must not claim error task');

      // User initiates explicit retry
      const retryRes = await backend.app.fetch(
        new Request(`http://127.0.0.1:9999/api/tasks/${task.id}/retry`, {
          method: 'POST',
        }),
      );
      assert(retryRes.status === 200, 'explicit retry must succeed');

      const taskAfterRetry = getTaskById(backend.db, task.id);
      assert(taskAfterRetry?.status === 'todo', 'task must be reset to todo');

      // Scheduler claims retried task with incremented generation
      const claim2 = await scheduler.scheduleNext();
      assert(claim2.claimed === true, 'scheduler must claim retried task');
      assert(claim2.taskId === task.id, 'claimed task must match');
      assert(claim2.runId !== claim1.runId, 'retried task must have fresh runId');
      assert((claim2.generation ?? 0) > (claim1.generation ?? 0), 'generation must be incremented');

      // Dispatch retried task with success scenario
      const ctx2 = await bClient.getTaskContext(task.id);
      const successRes = await dispatcher.dispatchTask({
        task: taskAfterRetry as unknown as TaskRecord,
        claim: {
          runId: claim2.runId ?? '',
          taskId: task.id,
          generation: claim2.generation ?? 2,
          status: 'running',
          workingTreeKey: claim2.workingTreeKey ?? '',
        },
        context: ctx2,
        scenario: 'success',
      });
      assert(successRes.status === 'done', 'retried task must complete to done');

      const finalDb = getTaskById(backend.db, task.id);
      assert(finalDb?.status === 'done', 'task in DB must be done');
    } finally {
      backend.cleanup();
    }
  },
);

// 6. Crash quarantine: adapter crash mid-turn quarantines working tree until supervisor clear-quarantine
await check(
  'e2e safety: adapter crash mid-turn quarantines working tree until supervisor clear-quarantine',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoDir = backend.createRepoDir('repo_e2e_quar');
      const repo = createRepository(backend.db, {
        name: 'repo_e2e_quar',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      const t1 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task 1 Crash',
        priority: 'P0',
      });

      const bClient = backend.createClient('engine');
      const supervisorClient = backend.createClient('supervisor');
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_e2e_quar' });
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_e2e_quar',
      });

      // Claim Task 1
      const claim1 = await scheduler.scheduleNext();
      assert(claim1.claimed === true, 'claim 1 must succeed');
      assert(claim1.taskId === t1.id, 'claim 1 must be t1');

      // Simulate crash: adapter fails or drops without verified stop
      await bClient.markUncertain(claim1.runId ?? '', {
        ownerId: 'engine_e2e_quar',
        generation: claim1.generation ?? 1,
        reason: 'Simulated adapter crash / unverified process state',
      });
      scheduler.releaseRun(claim1.runId ?? '');

      // Verify lock is quarantined in backend
      const runStatus = await bClient.getRun(claim1.runId ?? '');
      assert(runStatus.status === 'uncertain', 'run status must be uncertain');

      // Now create Task 2 waiting on that repo
      const t2 = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task 2 Waiting P0',
        priority: 'P0',
      });

      // Verify that NO task can claim this working tree now, even high-priority P0 Task 2!
      const schedBlocked = await scheduler.scheduleNext();
      assert(!schedBlocked.claimed, 'scheduler must not claim on quarantined tree');

      let claimBlocked = false;
      try {
        await bClient.claimTask(t2.id, {
          ownerId: 'engine_e2e_quar',
          generation: 1,
          idempotencyKey: 'quarantined_claim_attempt',
        });
      } catch (err: unknown) {
        if (err instanceof BackendClientError && err.status === 409) {
          claimBlocked = true;
          assert(err.message.includes('quarantined'), 'error message must indicate quarantine');
        }
      }
      assert(claimBlocked, 'claim on quarantined tree must be rejected with 409 LOCK_HELD');

      // Clear quarantine using supervisor role
      const clearRes = await supervisorClient.clearQuarantine(claim1.runId ?? '', {
        operatorId: 'supervisor_admin',
        reason: 'Admin verified process tree terminated',
      });
      assert(clearRes.ok === true, 'supervisor clear-quarantine must succeed');

      // Now working tree is unblocked! Task 2 (P0) can be claimed
      const claim2 = await scheduler.scheduleNext();
      assert(claim2.claimed === true, 'Task 2 must be claimed after clear-quarantine');
      assert(claim2.taskId === t2.id, 'claimed task must be Task 2');
      assert((claim2.generation ?? 0) > (claim1.generation ?? 0), 'generation must be incremented');

      const ctx2 = await bClient.getTaskContext(t2.id);
      const res2 = await dispatcher.dispatchTask({
        task: t2 as unknown as TaskRecord,
        claim: {
          runId: claim2.runId ?? '',
          taskId: t2.id,
          generation: claim2.generation ?? 2,
          status: 'running',
          workingTreeKey: claim2.workingTreeKey ?? '',
        },
        context: ctx2,
        scenario: 'success',
      });
      assert(res2.status === 'done', 'Task 2 must complete to done');
    } finally {
      backend.cleanup();
    }
  },
);

// 7. Both-provider scenario with Codex driver end-to-end through engine
await check('e2e safety: both-provider execution with Codex driver through engine', async () => {
  const backend = createTestBackend();
  const repoDir = backend.createRepoDir('repo_e2e_codex');
  const repo = createRepository(backend.db, {
    name: 'repo_e2e_codex',
    displayPath: repoDir,
    defaultProvider: 'codex',
  });

  const task = createTask(backend.db, {
    repoId: repo.id,
    title: 'Codex Engine E2E Task',
    priority: 'P0',
  });

  const codexDriver: AgentDriver = {
    provider: 'codex',
    start(run, callbacks) {
      callbacks.onEvent({
        runId: run.runId,
        sequence: 1,
        type: 'message.delta',
        timestamp: new Date().toISOString(),
        data: { messageId: 'm_codex_1', delta: 'Scanning project files...' },
      });
      callbacks.onEvent({
        runId: run.runId,
        sequence: 2,
        type: 'message.completed',
        timestamp: new Date().toISOString(),
        data: { messageId: 'm_codex_1', content: 'Codex completed analysis.' },
      });
      callbacks.onEvent({
        runId: run.runId,
        sequence: 3,
        type: 'completed',
        timestamp: new Date().toISOString(),
        data: { summary: 'Turn completed cleanly' },
      });

      run.status = 'done';
      run.verifiedStoppedAt = new Date().toISOString();
      run.verificationMethod = 'process_group_empty';
      run.exitCode = 0;
      callbacks.onEnd();
      return Promise.resolve();
    },
    cancel(run) {
      return Promise.resolve({
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
        exitCode: 143,
      });
    },
  };

  const adapter = createTestAdapter('engine-test-internal-token', { codexDriver });
  try {
    const bClient = backend.createClient();
    const aClient = adapter.createClient();
    const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_e2e_codex' });
    const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
      ownerId: 'engine_e2e_codex',
    });

    const claim = await scheduler.scheduleNext();
    assert(claim.claimed === true, 'claim must succeed');

    const ctx = await bClient.getTaskContext(task.id);
    const res = await dispatcher.dispatchTask({
      task: task as unknown as TaskRecord,
      claim: {
        runId: claim.runId ?? '',
        taskId: task.id,
        generation: claim.generation ?? 1,
        status: 'running',
        workingTreeKey: claim.workingTreeKey ?? '',
      },
      context: ctx,
      provider: 'codex',
    });

    assert(res.status === 'done', 'codex dispatch must complete to done');
    assert(res.verifiedStopped, 'codex run must have verified stop proof');
    assert(res.verificationMethod === 'process_group_empty', 'verification method must match');

    const messages = listMessages(backend.db, task.conversationId).messages;
    const agentMsg = messages.find((m) => m.sender === 'agent');
    assert(agentMsg !== undefined, 'agent message must be committed');
    assert(agentMsg?.content === 'Codex completed analysis.', 'message content must match');

    const dbTask = getTaskById(backend.db, task.id);
    assert(dbTask?.status === 'done', 'task in DB must be done');
  } finally {
    backend.cleanup();
  }
});

// 8. Both-provider scenario with Claude driver end-to-end through engine and session resume
await check(
  'e2e safety: both-provider execution with Claude driver through engine and session resume',
  async () => {
    const backend = createTestBackend();
    const repoDir = backend.createRepoDir('repo_e2e_claude');
    const repo = createRepository(backend.db, {
      name: 'repo_e2e_claude',
      displayPath: repoDir,
      defaultProvider: 'claude',
    });

    const task = createTask(backend.db, {
      repoId: repo.id,
      title: 'Claude Engine E2E Task',
      priority: 'P0',
    });

    let observedSessionId: string | undefined;
    let resumeUsed = false;

    const claudeDriver: AgentDriver = {
      provider: 'claude',
      start(run, callbacks) {
        if (run.sessionId) {
          resumeUsed = true;
          observedSessionId = run.sessionId;
        } else {
          observedSessionId = 'session_claude_pin_123';
          callbacks.onSessionId?.(observedSessionId);
        }

        callbacks.onEvent({
          runId: run.runId,
          sequence: 1,
          type: 'message.delta',
          timestamp: new Date().toISOString(),
          data: { messageId: 'm_claude_1', delta: 'Claude thinking...' },
        });
        callbacks.onEvent({
          runId: run.runId,
          sequence: 2,
          type: 'message.completed',
          timestamp: new Date().toISOString(),
          data: { messageId: 'm_claude_1', content: 'Claude finished answer.' },
        });
        callbacks.onEvent({
          runId: run.runId,
          sequence: 3,
          type: 'completed',
          timestamp: new Date().toISOString(),
          data: { summary: 'Turn complete' },
        });

        run.status = 'done';
        run.verifiedStoppedAt = new Date().toISOString();
        run.verificationMethod = 'process_group_empty';
        run.exitCode = 0;
        callbacks.onEnd();
        return Promise.resolve();
      },
      cancel(run) {
        return Promise.resolve({
          verifiedStopped: true,
          verificationMethod: 'process_group_empty',
          exitCode: 143,
        });
      },
    };

    const adapter = createTestAdapter('engine-test-internal-token', { claudeDriver });
    try {
      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_e2e_claude' });
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_e2e_claude',
      });

      const claim = await scheduler.scheduleNext();
      assert(claim.claimed === true, 'claim must succeed');

      const ctx = await bClient.getTaskContext(task.id);
      const res = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: claim.runId ?? '',
          taskId: task.id,
          generation: claim.generation ?? 1,
          status: 'running',
          workingTreeKey: claim.workingTreeKey ?? '',
        },
        context: ctx,
        provider: 'claude',
      });

      assert(res.status === 'done', 'claude dispatch must complete to done');
      assert(res.verifiedStopped, 'claude run must have verified stop proof');
      assert(observedSessionId === 'session_claude_pin_123', 'session id must be pinned');

      // Test session resume turn: start second run with sessionId
      const secondRunId = 'run_claude_resume_turn';
      await aClient.startRun({
        runId: secondRunId,
        taskId: task.id,
        provider: 'claude',
        cwd: repoDir,
        instruction: 'Followup turn',
        ownerId: 'engine_e2e_claude',
        generation: 2,
        sessionId: 'session_claude_pin_123',
      });

      assert(resumeUsed, 'driver must receive sessionId for cross-process session resume');
      assert(observedSessionId === 'session_claude_pin_123', 'resumed session id must match');
    } finally {
      backend.cleanup();
    }
  },
);

// 9. Missing terminal events follow T05 recovery rules instead of reporting unproved success
await check(
  'e2e safety: missing terminal events follow T05 recovery rules instead of reporting unproved success',
  async () => {
    const backend = createTestBackend();
    const adapter = createTestAdapter();
    try {
      const repoDir = backend.createRepoDir('repo_e2e_noterm');
      const repo = createRepository(backend.db, {
        name: 'repo_e2e_noterm',
        displayPath: repoDir,
        defaultProvider: 'codex',
      });

      const task = createTask(backend.db, {
        repoId: repo.id,
        title: 'Task Drops Stream Without Terminal Event',
        priority: 'P1',
      });

      const bClient = backend.createClient();
      const aClient = adapter.createClient();
      const scheduler = new TaskScheduler(bClient, { ownerId: 'engine_e2e_noterm' });
      const dispatcher = new RunDispatcher(bClient, aClient, scheduler, {
        ownerId: 'engine_e2e_noterm',
      });

      const claim = await scheduler.scheduleNext();
      assert(claim.claimed === true, 'claim must succeed');

      // Run 'disconnect' scenario: emits message.delta then drops stream without terminal event (completed/failed)
      // The adapter run remains in 'running' state with no verified stop proof!
      const ctx = await bClient.getTaskContext(task.id);
      const res = await dispatcher.dispatchTask({
        task: task as unknown as TaskRecord,
        claim: {
          runId: claim.runId ?? '',
          taskId: task.id,
          generation: claim.generation ?? 1,
          status: 'running',
          workingTreeKey: claim.workingTreeKey ?? '',
        },
        context: ctx,
        scenario: 'disconnect',
      });

      // Crucial: The engine MUST NOT assume success!
      assert(
        res.status !== 'done',
        'engine must NEVER assume success when stream drops without terminal event',
      );

      // Simulate adapter crash / loss of run state (e.g. process died, adapter restarted/404)
      (adapter.manager as unknown as { runs: Map<string, unknown> }).runs.delete(claim.runId ?? '');

      // The reconciler reconciles unverified runs:
      const reconciler = new RunReconciler(bClient, aClient, scheduler, {
        ownerId: 'engine_e2e_noterm',
      });

      const recResult = await reconciler.reconcileRun(claim.runId ?? '', claim.generation ?? 1);

      // If adapter has lost state or cannot verify stop, it MUST be marked uncertain and quarantined
      assert(
        recResult.status === 'uncertain',
        `expected uncertain status for missing terminal event, got ${recResult.status}`,
      );
      assert(!recResult.verifiedStopped, 'cannot be marked verified stopped');
      assert(recResult.quarantined === true, 'lock must be quarantined');

      // Working tree lock must be quarantined in backend
      const runStatus = await bClient.getRun(claim.runId ?? '');
      assert(runStatus.status === 'uncertain', 'run status in backend must be uncertain');

      // Subsequent claim blocked by quarantine
      let claimBlocked = false;
      try {
        await bClient.claimTask(task.id, {
          ownerId: 'engine_e2e_noterm',
          generation: 1,
          idempotencyKey: 'reclaim_attempt',
        });
      } catch (err: unknown) {
        if (err instanceof BackendClientError && err.status === 409) {
          claimBlocked = true;
        }
      }
      assert(claimBlocked, 'working tree must remain quarantined preventing second writer');
    } finally {
      backend.cleanup();
    }
  },
);

// Summary
const failed = results.filter((r) => !r.passed);
console.log(`\nResults: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error('Failed checks:', failed);
  process.exit(1);
}
process.exit(0);
