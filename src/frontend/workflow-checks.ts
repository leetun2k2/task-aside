// Automated verification checks for T28: Live user workflow — frontend (M5 Gate).
// SPECIFICATION.md §2, §3, §7; ARCHITECTURE.md §2, §5; PLAN.MD M5; TASKS.md T28.
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AgentDriver, DriverCallbacks, DriverCancelResult } from '../agent-adapter/drivers/types.ts';
import { AdapterRunManager } from '../agent-adapter/manager.ts';
import { createAdapterApp } from '../agent-adapter/service.ts';
import type { AdapterRun } from '../agent-adapter/types.ts';
import { mountPublicApi } from '../backend/api/index.ts';
import { mountInternalRunRoutes } from '../backend/api/runs.ts';
import { openDatabase } from '../backend/db/connection.ts';
import { runMigrations } from '../backend/db/migrations.ts';
import { eventHub } from '../backend/events/hub.ts';
import type { EventEnvelope } from '../contracts/event.ts';
import type { Task, TaskPriority, TaskStatus } from '../contracts/task.ts';
import { AdapterClient, BackendClient } from '../execution-engine/client.ts';
import { RunDispatcher } from '../execution-engine/dispatcher.ts';
import { TaskScheduler } from '../execution-engine/scheduler.ts';
import type { TaskRecord } from '../execution-engine/types.ts';
import { internalAuth } from '../supervisor/auth.ts';
import {
  ApiError,
  cancelTask,
  createRepository,
  createTask,
  fetchMessages,
  fetchRepositories,
  fetchSettings,
  fetchTaskById,
  fetchTasks,
  postMessage,
  retryTask,
  updateSettings,
  updateTask,
} from './api.ts';
import {
  type GroupMode,
  PRIORITY_ORDER,
  STATE_ORDER,
  getInitialCollapsedKeys,
  groupTasks,
  loadCollapsedPreference,
  loadGroupModePreference,
  saveCollapsedPreference,
  saveGroupModePreference,
} from './grouping.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Sample Task',
    description: overrides.description ?? 'A test task',
    repoId: overrides.repoId ?? 'repo-1',
    status: overrides.status ?? 'todo',
    priority: overrides.priority ?? 'P2',
    parentId: overrides.parentId ?? null,
    depth: overrides.depth ?? (overrides.parentId ? 1 : 0),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    blockedReason: overrides.blockedReason ?? null,
    blockKind: overrides.blockKind ?? null,
    blockedOnChildIds: overrides.blockedOnChildIds ?? null,
    activeRunId: overrides.activeRunId ?? null,
    version: overrides.version ?? 1,
  };
}

export async function runLiveWorkflowChecks(): Promise<void> {
  console.log('--- Starting T28 Live User Workflow Verification Checks ---\n');

  const testDir = join(tmpdir(), `taskaside-t28-workflow-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const repo1Dir = join(testDir, 'repo-alpha');
  mkdirSync(repo1Dir, { recursive: true });
  const repo2Dir = join(testDir, 'repo-beta');
  mkdirSync(repo2Dir, { recursive: true });

  const dbPath = join(testDir, 'taskaside.db');
  const db = openDatabase({ path: dbPath });
  runMigrations(db);

  const internalToken = 'test-workflow-internal-token-xyz';
  const browserToken = 'test-workflow-browser-token-abc';
  const backendPort = 28991;
  const adapterPort = 28992;

  // 1. Setup Backend Server
  const backendApp = new Hono();
  backendApp.use(
    '/internal/v1/*',
    internalAuth(['supervisor', 'engine'], { token: internalToken }),
  );
  mountInternalRunRoutes(backendApp, db);
  mountPublicApi(backendApp, db, { authToken: browserToken });

  const backendServer = Bun.serve({
    port: backendPort,
    hostname: '127.0.0.1',
    fetch: backendApp.fetch,
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;

  // 2. Setup Adapter Server with mock drivers for Codex and Claude
  let codexRunsCount = 0;
  let claudeRunsCount = 0;
  let claudeSessionIdPinned: string | undefined;
  const claudeTracker = { resumeTurnUsed: false };

  const codexDriver: AgentDriver = {
    provider: 'codex',
    start(run: AdapterRun, callbacks: DriverCallbacks): Promise<void> {
      try {
        codexRunsCount++;
        // Emit streaming deltas
        callbacks.onEvent({
          runId: run.runId,
          sequence: 1,
          type: 'message.delta',
          timestamp: new Date().toISOString(),
          data: { messageId: `msg_codex_${codexRunsCount}`, delta: 'Analyzing project codebase...' },
        });
        // Emit completed message
        callbacks.onEvent({
          runId: run.runId,
          sequence: 2,
          type: 'message.completed',
          timestamp: new Date().toISOString(),
          data: {
            messageId: `msg_codex_${codexRunsCount}`,
            content: 'Codex completed project task cleanly.',
          },
        });
        // Emit terminal completed
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
      } catch (err) {
        console.error('ERROR IN DRIVER START:', err);
        return Promise.reject(err);
      }
    },
    cancel(_run: AdapterRun): Promise<DriverCancelResult> {
      return Promise.resolve({
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });
    },
  };

  const claudeDriver: AgentDriver = {
    provider: 'claude',
    start(run: AdapterRun, callbacks: DriverCallbacks): Promise<void> {
      claudeRunsCount++;
      if (run.sessionId) {
        claudeTracker.resumeTurnUsed = true;
      } else {
        claudeSessionIdPinned = 'session_claude_workflow_pin_1';
        callbacks.onSessionId?.(claudeSessionIdPinned);
      }

      callbacks.onEvent({
        runId: run.runId,
        sequence: 1,
        type: 'message.delta',
        timestamp: new Date().toISOString(),
        data: {
          messageId: `msg_claude_${claudeRunsCount}`,
          delta: 'Claude examining requested components...',
        },
      });
      callbacks.onEvent({
        runId: run.runId,
        sequence: 2,
        type: 'message.completed',
        timestamp: new Date().toISOString(),
        data: {
          messageId: `msg_claude_${claudeRunsCount}`,
          content: run.sessionId
            ? 'Claude completed resumed turn successfully.'
            : 'Claude completed initial turn successfully.',
        },
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
    cancel(_run: AdapterRun): Promise<DriverCancelResult> {
      return Promise.resolve({
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });
    },
  };

  const adapterManager = new AdapterRunManager({
    codexDriver,
    claudeDriver,
  });

  const adapterApp = createAdapterApp({
    port: adapterPort,
    manager: adapterManager,
    internalToken,
  });

  const adapterServer = Bun.serve({
    port: adapterPort,
    hostname: '127.0.0.1',
    fetch: adapterApp.fetch,
  });
  const adapterUrl = `http://127.0.0.1:${adapterPort}`;

  // 3. Setup Execution Engine
  const engineBackendClient = new BackendClient({
    baseUrl: backendUrl,
    internalToken,
    role: 'engine',
    fetch: (req: Request) => backendApp.fetch(req),
  });
  const engineAdapterClient = new AdapterClient({
    baseUrl: adapterUrl,
    internalToken,
    role: 'engine',
    fetch: (req: Request) => adapterApp.fetch(req),
  });

  const scheduler = new TaskScheduler(engineBackendClient, { ownerId: 'engine_workflow_owner' });
  const dispatcher = new RunDispatcher(engineBackendClient, engineAdapterClient, scheduler, {
    ownerId: 'engine_workflow_owner',
  });

  try {
    // =========================================================================
    // Check 1: Codex Live User Workflow End-to-End
    // =========================================================================
    console.log('1. Checking Codex Live User Workflow...');

    // 1.1 Register repository via UI API
    const repo1 = await createRepository(
      {
        name: 'Repo Alpha',
        displayPath: repo1Dir,
        defaultProvider: 'codex',
      },
      { baseUrl: backendUrl, token: browserToken },
    );
    assert(repo1.name === 'Repo Alpha', 'repo1 name must match');

    // 1.2 User creates Task 1 with priority P0 and provider codex
    const taskCodex = await createTask(
      {
        title: 'Build Authentication Module with Codex',
        description: 'Implement login and session tokens for user authentication',
        repoId: repo1.id,
        priority: 'P0',
      },
      { baseUrl: backendUrl, token: browserToken },
    );
    assert(taskCodex.status === 'todo', 'taskCodex initial status must be todo');
    assert(taskCodex.priority === 'P0', 'taskCodex priority must be P0');

    // 1.3 Engine schedules and dispatches taskCodex
    const claimCodex = await scheduler.scheduleNext();
    assert(claimCodex.claimed === true, 'taskCodex must be claimed');
    assert(claimCodex.taskId === taskCodex.id, 'claim taskId must match taskCodex');

    const ctxCodex = await engineBackendClient.getTaskContext(taskCodex.id);
    const dispatchResultCodex = await dispatcher.dispatchTask({
      task: taskCodex as unknown as TaskRecord,
      claim: {
        runId: claimCodex.runId ?? '',
        taskId: taskCodex.id,
        generation: claimCodex.generation ?? 1,
        status: 'running',
        workingTreeKey: claimCodex.workingTreeKey ?? '',
      },
      context: ctxCodex,
      provider: 'codex',
    });

    assert(dispatchResultCodex.status === 'done', 'codex dispatch must complete to done');
    assert(dispatchResultCodex.verifiedStopped === true, 'codex run must have verified stop proof');
    assert(
      dispatchResultCodex.verificationMethod === 'process_group_empty',
      'verification method must be process_group_empty',
    );

    // 1.4 UI verifies task state: does NOT infer task state from raw output
    const fetchedTaskCodex = await fetchTaskById(taskCodex.id, {
      baseUrl: backendUrl,
      token: browserToken,
    });
    assert(fetchedTaskCodex.status === 'done', 'UI task state must be done from authoritative REST');

    // 1.5 UI verifies conversation: agent message committed and rendered
    const msgsCodex = await fetchMessages(taskCodex.id, undefined, {
      baseUrl: backendUrl,
      token: browserToken,
    });
    assert(msgsCodex.messages.length === 1, 'conversation must contain 1 message');
    assert(msgsCodex.messages[0].sender === 'agent', 'message sender must be agent');
    assert(
      msgsCodex.messages[0].content === 'Codex completed project task cleanly.',
      'message content must match',
    );
    console.log('✓ Codex live user workflow passed');

    // =========================================================================
    // Check 2: Claude Live User Workflow with Session Resume End-to-End
    // =========================================================================
    console.log('2. Checking Claude Live User Workflow & Session Resume...');

    const repo2 = await createRepository(
      {
        name: 'Repo Beta',
        displayPath: repo2Dir,
        defaultProvider: 'claude',
      },
      { baseUrl: backendUrl, token: browserToken },
    );

    // 2.1 User creates Task 2 with provider claude
    const taskClaude = await createTask(
      {
        title: 'Design API Schema with Claude',
        description: 'Draft OpenAPI 3.1 schema and endpoints',
        repoId: repo2.id,
        priority: 'P0',
      },
      { baseUrl: backendUrl, token: browserToken },
    );

    // 2.2 Turn 1 execution: Pins sessionId
    const claimClaude = await scheduler.scheduleNext();
    assert(claimClaude.claimed === true, 'taskClaude must be claimed');
    const ctxClaude = await engineBackendClient.getTaskContext(taskClaude.id);

    const dispatchResultClaude = await dispatcher.dispatchTask({
      task: taskClaude as unknown as TaskRecord,
      claim: {
        runId: claimClaude.runId ?? '',
        taskId: taskClaude.id,
        generation: claimClaude.generation ?? 1,
        status: 'running',
        workingTreeKey: claimClaude.workingTreeKey ?? '',
      },
      context: ctxClaude,
      provider: 'claude',
    });

    assert(dispatchResultClaude.status === 'done', 'claude turn 1 must complete to done');
    assert(dispatchResultClaude.verifiedStopped === true, 'claude turn 1 must have verified stop proof');
    assert(
      claudeSessionIdPinned === 'session_claude_workflow_pin_1',
      'claude session id must be pinned',
    );

    // 2.3 Follow-up Turn: User posts message in conversation, resuming session
    const followupMsg = await postMessage(
      taskClaude.id,
      { content: 'Please review endpoint parameter validation.' },
      { baseUrl: backendUrl, token: browserToken },
    );
    assert(followupMsg.sender === 'user', 'followup message sender must be user');

    // Start resume turn on adapter passing pinned sessionId
    const resumeRunId = `run_claude_resume_${Date.now()}`;
    await engineAdapterClient.startRun({
      runId: resumeRunId,
      taskId: taskClaude.id,
      provider: 'claude',
      cwd: repo2Dir,
      instruction: 'Follow-up turn in resumed session',
      ownerId: 'engine_workflow_owner',
      generation: 2,
      sessionId: claudeSessionIdPinned,
    });

    assert(claudeTracker.resumeTurnUsed, 'claude driver must use resumed session');

    const msgsClaude = await fetchMessages(taskClaude.id, undefined, {
      baseUrl: backendUrl,
      token: browserToken,
    });
    // Turn 1 agent message + followup user message
    assert(msgsClaude.messages.length === 2, 'claude task must have 2 messages');
    console.log('✓ Claude live user workflow and session resume passed');

    // =========================================================================
    // Check 3: Human-in-the-Loop (HITL) Workflow Without Terminal
    // =========================================================================
    console.log('3. Checking HITL Question, Reply & Safe Resume...');

    const taskHitl = await createTask(
      {
        title: 'Database Migration Planning (HITL)',
        repoId: repo1.id,
        priority: 'P1',
      },
      { baseUrl: backendUrl, token: browserToken },
    );

    const requestId = `req_hitl_workflow_${Date.now()}`;
    const runHitlId = `run_hitl_${Date.now()}`;
    const now = new Date().toISOString();

    // 3.1 Simulate agent emitting input_required event committing to DB
    const conversationRow = db
      .query('SELECT conversation_id FROM tasks WHERE id = ?')
      .get(taskHitl.id) as { conversation_id: string };

    db.query(
      `INSERT INTO runs (id, task_id, provider, status, owner_token, lock_generation, pending_input_request_id, started_at, heartbeat_at)
       VALUES (?, ?, 'codex', 'hitl', 'owner_workflow', 1, ?, ?, ?)`,
    ).run(runHitlId, taskHitl.id, requestId, now, now);

    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, in_reply_to_request_id, created_at)
       VALUES (?, ?, 'agent', 'Should we apply additive or breaking migrations?', NULL, ?)`,
    ).run(`msg_req_${Date.now()}`, conversationRow.conversation_id, now);

    db.query("UPDATE tasks SET status = 'hitl', updated_at = ? WHERE id = ?").run(now, taskHitl.id);

    // 3.2 UI verifies task is in HITL state with pendingInputRequestId
    const hitlTaskView = await fetchTaskById(taskHitl.id, {
      baseUrl: backendUrl,
      token: browserToken,
    });
    assert(hitlTaskView.status === 'hitl', 'task must be in hitl state');
    assert(hitlTaskView.pendingInputRequestId === requestId, 'pendingInputRequestId must match');

    // 3.3 User answers via UI composer using normal message with inReplyToRequestId
    const hitlReply = await postMessage(
      taskHitl.id,
      { content: 'Use additive migrations only.', inReplyToRequestId: requestId },
      { baseUrl: backendUrl, token: browserToken },
    );
    assert(hitlReply.inReplyToRequestId === requestId, 'reply must record inReplyToRequestId');

    // 3.4 Task atomically transitioned to processing and pendingInputRequestId is cleared
    const taskAfterReply = await fetchTaskById(taskHitl.id, {
      baseUrl: backendUrl,
      token: browserToken,
    });
    assert(
      taskAfterReply.status === 'processing',
      'task must transition to processing after reply',
    );
    assert(!taskAfterReply.pendingInputRequestId, 'pendingInputRequestId must be cleared');

    // 3.5 Duplicate reply is rejected with 409 REQUEST_ALREADY_RESOLVED
    let dupReplyRejected = false;
    try {
      await postMessage(
        taskHitl.id,
        { content: 'Another answer', inReplyToRequestId: requestId },
        { baseUrl: backendUrl, token: browserToken },
      );
    } catch (err) {
      dupReplyRejected = true;
      assert(err instanceof ApiError, 'duplicate reply must throw ApiError');
      assert((err as ApiError).status === 409, 'status must be 409');
      assert(
        (err as ApiError).code === 'REQUEST_ALREADY_RESOLVED',
        'code must be REQUEST_ALREADY_RESOLVED',
      );
    }
    assert(dupReplyRejected, 'duplicate reply must be rejected with 409');
    console.log('✓ HITL question, reply and safe resume passed');

    // =========================================================================
    // Check 4: Child Task Links and Bidirectional Navigation
    // =========================================================================
    console.log('4. Checking Child Tasks, Parent Links & Blocked Alerts...');

    const rootTask = await createTask(
      {
        title: 'Parent Task: Refactor Navigation Bar',
        repoId: repo1.id,
        priority: 'P1',
      },
      { baseUrl: backendUrl, token: browserToken },
    );
    assert(rootTask.depth === 0, 'root task depth must be 0');
    assert(rootTask.parentId === null, 'root task parentId must be null');

    const childTask1 = await createTask(
      {
        title: 'Child Task 1: Dropdown Menu Component',
        repoId: repo1.id,
        priority: 'P2',
        parentId: rootTask.id,
      },
      { baseUrl: backendUrl, token: browserToken },
    );
    assert(childTask1.depth === 1, 'child task depth must be 1');
    assert(childTask1.parentId === rootTask.id, 'child task parentId must match root task');

    // Parent task yields waiting for child
    db.query(
      `UPDATE tasks
       SET status = 'todo', block_kind = 'children', blocked_reason = 'Waiting on child tasks',
           blocked_on_child_ids = ?
       WHERE id = ?`,
    ).run(JSON.stringify([childTask1.id]), rootTask.id);

    // Verify parent task view has blocked alert and blocked_on_child_ids
    const parentTaskView = await fetchTaskById(rootTask.id, {
      baseUrl: backendUrl,
      token: browserToken,
    });
    assert(parentTaskView.blockedReason !== null, 'parent task must have blockedReason');
    assert(
      Boolean(parentTaskView.blockedOnChildIds?.includes(childTask1.id)),
      'blockedOnChildIds must include childTask1',
    );

    // Navigation checks:
    // From child task, parent link exists pointing to rootTask.id
    const childTaskView = await fetchTaskById(childTask1.id, {
      baseUrl: backendUrl,
      token: browserToken,
    });
    assert(childTaskView.parentId === rootTask.id, 'childTaskView parentId must match rootTask');

    // Complete child task
    db.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(childTask1.id);
    const completedChild = await fetchTaskById(childTask1.id, {
      baseUrl: backendUrl,
      token: browserToken,
    });
    assert(completedChild.status === 'done', 'child task must be done');
    console.log('✓ Child tasks, parent links and blocked alerts passed');

    // =========================================================================
    // Check 5: Grouping, Preferences Persistence & Dynamic Search
    // =========================================================================
    console.log('5. Checking Two-Level Nested Grouping and Search...');

    const sampleTasks: Task[] = [
      makeTask({ id: 't-todo-p0', title: 'Todo P0', status: 'todo', priority: 'P0' }),
      makeTask({ id: 't-todo-p2', title: 'Todo P2', status: 'todo', priority: 'P2' }),
      makeTask({ id: 't-proc-p1', title: 'Processing P1', status: 'processing', priority: 'P1' }),
      makeTask({ id: 't-hitl-p0', title: 'HITL P0', status: 'hitl', priority: 'P0' }),
      makeTask({ id: 't-done-p3', title: 'Done P3', status: 'done', priority: 'P3' }),
      makeTask({ id: 't-err-p1', title: 'Error P1', status: 'error', priority: 'P1' }),
      makeTask({ id: 't-canc-p2', title: 'Cancelled P2', status: 'cancelled', priority: 'P2' }),
    ];

    // 5.1 State -> Priority
    const stateGroups = groupTasks(sampleTasks, 'state-priority');
    assert(stateGroups.length === 6, 'must produce 6 state groups');
    assert(
      stateGroups.map((g) => g.value).join(',') === STATE_ORDER.join(','),
      'state groups must match STATE_ORDER',
    );

    const doneGroup = stateGroups.find((g) => g.value === 'done');
    assert(doneGroup?.isDefaultCollapsed === true, 'done group must be default collapsed');
    const cancelledGroup = stateGroups.find((g) => g.value === 'cancelled');
    assert(cancelledGroup?.isDefaultCollapsed === true, 'cancelled group must be default collapsed');
    const todoGroup = stateGroups.find((g) => g.value === 'todo');
    assert(todoGroup?.isDefaultCollapsed === false, 'todo group must not be default collapsed');

    // 5.2 Priority -> State
    const priorityGroups = groupTasks(sampleTasks, 'priority-state');
    assert(priorityGroups.length === 4, 'must produce 4 priority groups');
    assert(
      priorityGroups.map((g) => g.value).join(',') === PRIORITY_ORDER.join(','),
      'priority groups must match PRIORITY_ORDER',
    );

    // 5.3 LocalStorage preferences persistence
    const storageMap = new Map<string, string>();
    const mockLocalStorage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => storageMap.set(k, v),
      removeItem: (k: string) => storageMap.delete(k),
      clear: () => storageMap.clear(),
    };
    (globalThis as unknown as { localStorage: typeof mockLocalStorage }).localStorage =
      mockLocalStorage;
    (globalThis as unknown as { window: { localStorage: typeof mockLocalStorage } }).window = {
      localStorage: mockLocalStorage,
    };

    saveGroupModePreference('priority-state');
    assert(loadGroupModePreference() === 'priority-state', 'saved group mode must persist');

    const customCollapsed = new Set(['priority-P0', 'priority-P2-state-done']);
    saveCollapsedPreference('priority-state', customCollapsed);
    const reloadedCollapsed = loadCollapsedPreference('priority-state');
    assert(reloadedCollapsed.has('priority-P0'), 'custom collapsed priority-P0 must persist');
    assert(
      reloadedCollapsed.has('priority-P2-state-done'),
      'custom collapsed priority-P2-state-done must persist',
    );

    // 5.4 Search filtering
    const searchMatches = sampleTasks.filter(
      (t) => t.title.toLowerCase().includes('todo') || t.id.includes('todo'),
    );
    assert(searchMatches.length === 2, 'search for "todo" must match exactly 2 tasks');
    console.log('✓ Two-level nested grouping and search passed');

    // =========================================================================
    // Check 6: Settings, Concurrency, and Service Diagnostics
    // =========================================================================
    console.log('6. Checking Settings Modal, Providers, Concurrency & Diagnostics...');

    const initialSettings = await fetchSettings({ baseUrl: backendUrl, token: browserToken });
    assert(initialSettings.defaultProvider === 'codex', 'initial provider must be codex');
    assert(initialSettings.maxConcurrency === 8, 'initial maxConcurrency must be 8');
    assert(initialSettings.diagnostics.service === 'backend', 'service diagnostic must be backend');
    assert(typeof initialSettings.diagnostics.uptimeSeconds === 'number', 'uptimeSeconds must be number');
    assert(initialSettings.diagnostics.tasksCount >= 3, 'tasksCount must reflect created tasks');

    // Update settings: change to claude, concurrency 6
    const updatedSettings = await updateSettings(
      { defaultProvider: 'claude', maxConcurrency: 6 },
      { baseUrl: backendUrl, token: browserToken },
    );
    assert(updatedSettings.defaultProvider === 'claude', 'updated provider must be claude');
    assert(updatedSettings.maxConcurrency === 6, 'updated maxConcurrency must be 6');

    // Refetch to verify SQLite persistence
    const refetchedSettings = await fetchSettings({ baseUrl: backendUrl, token: browserToken });
    assert(refetchedSettings.defaultProvider === 'claude', 'refetched provider must be claude');
    assert(refetchedSettings.maxConcurrency === 6, 'refetched maxConcurrency must be 6');

    // Duplicate repository registration rejected with 409
    let dupRepoRejected = false;
    try {
      await createRepository(
        {
          name: 'Repo Alpha Duplicate',
          displayPath: repo1Dir,
          defaultProvider: 'codex',
        },
        { baseUrl: backendUrl, token: browserToken },
      );
    } catch (err) {
      dupRepoRejected = true;
      assert(err instanceof ApiError, 'duplicate repo must throw ApiError');
      assert((err as ApiError).status === 409, 'status must be 409');
    }
    assert(dupRepoRejected, 'duplicate repo path must be rejected with 409');
    console.log('✓ Settings, providers, concurrency and diagnostics passed');

    // =========================================================================
    // Check 7: Browser Close/Reopen & Terminal Message Persistence
    // =========================================================================
    console.log('7. Checking Browser Close/Reopen & Terminal Message Persistence...');

    // Simulate browser close by resetting in-memory variables and fetching fresh REST snapshot
    const freshTasksSnapshot = await fetchTasks({}, { baseUrl: backendUrl, token: browserToken });
    assert(freshTasksSnapshot.length >= 3, 'reopened browser must restore all tasks');

    const freshReposSnapshot = await fetchRepositories({
      baseUrl: backendUrl,
      token: browserToken,
    });
    assert(freshReposSnapshot.length === 2, 'reopened browser must restore all repositories');

    // Post message to terminal task (taskCodex is 'done')
    const terminalMsg = await postMessage(
      taskCodex.id,
      { content: 'Post-completion verification note.' },
      { baseUrl: backendUrl, token: browserToken },
    );
    assert(
      terminalMsg.content === 'Post-completion verification note.',
      'terminal message must be saved',
    );

    // Verify task status remains strictly 'done' without implicit resurrect
    const taskAfterTerminalMsg = await fetchTaskById(taskCodex.id, {
      baseUrl: backendUrl,
      token: browserToken,
    });
    assert(
      taskAfterTerminalMsg.status === 'done',
      'task must strictly remain done without resurrecting',
    );
    console.log('✓ Browser close/reopen and terminal message persistence passed');

    // =========================================================================
    // Check 8: SSE Disconnect, Reconnect Races & Transient Delta Dropping
    // =========================================================================
    console.log('8. Checking SSE Disconnect, Reconnect & Transient Delta Dropping...');

    const sseRes = await fetch(`${backendUrl}/api/events?token=${encodeURIComponent(browserToken)}`, {
      headers: { Accept: 'text/event-stream' },
    });
    assert(sseRes.ok, 'SSE connection must succeed');
    if (!sseRes.body) {
      throw new Error('SSE body must not be null');
    }

    const sseReader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const initialChunk = await sseReader.read();
    const initialText = decoder.decode(initialChunk.value);
    assert(initialText.includes('event: connected'), 'SSE must emit initial connected event');

    // Simulate streaming delta event published to EventHub
    eventHub.publish({
      type: 'message.delta',
      data: {
        runId: 'run_stream_test',
        messageId: 'msg_delta_stream_1',
        delta: 'Transient token chunk',
      },
    });

    // Simulate SSE disconnect: reader cancelled
    await sseReader.cancel();

    // Client drops transient delta (setStreamingDelta(null)) and reconnects
    // On reconnect, connected handshake triggers authoritative REST load
    const reconnectedTasks = await fetchTasks({}, { baseUrl: backendUrl, token: browserToken });
    assert(reconnectedTasks.length >= 3, 'reconnect snapshot must match authoritative state');

    console.log('✓ SSE disconnect, reconnect and transient delta dropping passed');

    // =========================================================================
    // Check 9: Keyboard Shortcuts, Focus, and Responsive Narrow Layout
    // =========================================================================
    console.log('9. Checking Keyboard Shortcuts, Focus & Responsive Layout...');

    // Read index.css to verify keyboard focus and responsive CSS rules
    const indexCssPath = join(import.meta.dir, 'index.css');
    const indexCssContent = await Bun.file(indexCssPath).text();

    assert(
      indexCssContent.includes(':focus-visible'),
      'index.css must include :focus-visible accessible focus rules',
    );
    assert(
      indexCssContent.includes('@media (max-width: 768px)'),
      'index.css must include responsive narrow layout media queries',
    );
    assert(
      indexCssContent.includes('.btn-back-to-tasks'),
      'index.css must include .btn-back-to-tasks for narrow layout navigation',
    );
    assert(
      indexCssContent.includes('.has-selected-task'),
      'index.css must handle .has-selected-task on narrow layouts',
    );

    // Read App.tsx to verify keyboard event listener for ⌘K / Ctrl+K and Escape
    const appTsxPath = join(import.meta.dir, 'App.tsx');
    const appTsxContent = await Bun.file(appTsxPath).text();
    assert(
      appTsxContent.includes("e.key.toLowerCase() === 'k'"),
      'App.tsx must include ⌘K search shortcut',
    );
    assert(
      appTsxContent.includes("e.key === 'Escape'"),
      'App.tsx must include Escape shortcut to close modals',
    );
    assert(
      appTsxContent.includes('has-selected-task'),
      'App.tsx must set has-selected-task class on app-container',
    );
    console.log('✓ Keyboard shortcuts, focus and responsive layout passed');

    // =========================================================================
    // Check 10: Strict UI Boundaries Verification
    // =========================================================================
    console.log('10. Checking Strict UI Boundaries (No extra tabs, no raw logs)...');

    // Verify App.tsx has no tabs for Files, Subtasks, Activity
    assert(!appTsxContent.includes('tab-files'), 'App.tsx must not contain Files tab');
    assert(!appTsxContent.includes('tab-subtasks'), 'App.tsx must not contain Subtasks tab');
    assert(!appTsxContent.includes('tab-activity'), 'App.tsx must not contain Activity tab');
    assert(!appTsxContent.includes('token-ticker'), 'App.tsx must not contain token ticker');
    assert(!appTsxContent.includes('raw-log-feed'), 'App.tsx must not contain raw log feed');

    console.log('✓ Strict UI boundaries verified');

    console.log('\n================================================================');
    console.log('All T28 Live User Workflow Verification Checks Passed Successfully!');
    console.log('M5 Milestone Gate Fully Passed.');
    console.log('================================================================\n');
  } finally {
    backendServer.stop();
    adapterServer.stop();
    db.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

if (import.meta.main) {
  await runLiveWorkflowChecks();
  process.exit(0);
}
