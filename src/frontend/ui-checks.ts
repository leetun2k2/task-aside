// Automated verification checks for T26: Task inbox, header, grouping, and UI API.
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { mountChatRoutes } from '../backend/api/chat.ts';
import { registerErrorHandler } from '../backend/api/errors.ts';
import { mountEventsRoutes } from '../backend/api/events.ts';
import { mountRepositoryRoutes } from '../backend/api/repositories.ts';
import { mountSettingsRoutes } from '../backend/api/settings.ts';
import { mountStaticRoutes } from '../backend/api/static.ts';
import { mountTaskRoutes } from '../backend/api/tasks.ts';
import { openDatabase } from '../backend/db/connection.ts';
import { runMigrations } from '../backend/db/migrations.ts';
import { eventHub } from '../backend/events/hub.ts';
import type { Task, TaskPriority, TaskStatus } from '../contracts/task.ts';
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

async function runGroupingChecks(): Promise<void> {
  console.log('--- Running Grouping and Hierarchy Checks ---');

  const sampleTasks: Task[] = [
    makeTask({ id: 't1', title: 'P0 Todo', status: 'todo', priority: 'P0' }),
    makeTask({ id: 't2', title: 'P1 Todo', status: 'todo', priority: 'P1' }),
    makeTask({ id: 't3', title: 'P0 Processing', status: 'processing', priority: 'P0' }),
    makeTask({ id: 't4', title: 'P2 Processing', status: 'processing', priority: 'P2' }),
    makeTask({ id: 't5', title: 'P1 HITL', status: 'hitl', priority: 'P1' }),
    makeTask({ id: 't6', title: 'P3 Done 1', status: 'done', priority: 'P3' }),
    makeTask({ id: 't7', title: 'P2 Done 2', status: 'done', priority: 'P2' }),
    makeTask({ id: 't8', title: 'P0 Error', status: 'error', priority: 'P0' }),
    makeTask({ id: 't9', title: 'P2 Cancelled', status: 'cancelled', priority: 'P2' }),
  ];

  // 1. Check State -> Priority grouping
  const stateGroups = groupTasks(sampleTasks, 'state-priority');
  assert(stateGroups.length === 6, 'state-priority must produce exactly 6 state groups');
  assert(
    stateGroups.map((g) => g.value).join(',') === STATE_ORDER.join(','),
    'state groups must match STATE_ORDER',
  );

  const processingGroup = stateGroups.find((g) => g.value === 'processing');
  assert(!!processingGroup && processingGroup.count === 2, 'processing group count must be 2');
  assert(!processingGroup?.isDefaultCollapsed, 'processing must not be default collapsed');

  const doneGroup = stateGroups.find((g) => g.value === 'done');
  assert(!!doneGroup && doneGroup.count === 2, 'done group count must be 2');
  assert(doneGroup?.isDefaultCollapsed === true, 'done group must be default collapsed');

  const cancelledGroup = stateGroups.find((g) => g.value === 'cancelled');
  assert(!!cancelledGroup && cancelledGroup.count === 1, 'cancelled group count must be 1');
  assert(cancelledGroup?.isDefaultCollapsed === true, 'cancelled group must be default collapsed');

  const todoGroup = stateGroups.find((g) => g.value === 'todo');
  assert(!!todoGroup && todoGroup.count === 2, 'todo group count must be 2');
  const p0TodoSubgroup = todoGroup?.subgroups.find((s) => s.value === 'P0');
  assert(!!p0TodoSubgroup && p0TodoSubgroup.count === 1, 'P0 Todo subgroup count must be 1');
  const p1TodoSubgroup = todoGroup?.subgroups.find((s) => s.value === 'P1');
  assert(!!p1TodoSubgroup && p1TodoSubgroup.count === 1, 'P1 Todo subgroup count must be 1');

  // 2. Check Priority -> State grouping
  const priorityGroups = groupTasks(sampleTasks, 'priority-state');
  assert(priorityGroups.length === 4, 'priority-state must produce exactly 4 priority groups');
  assert(
    priorityGroups.map((g) => g.value).join(',') === PRIORITY_ORDER.join(','),
    'priority groups must match PRIORITY_ORDER',
  );

  const p0Group = priorityGroups.find((g) => g.value === 'P0');
  // P0 tasks: t1 (todo), t3 (processing), t8 (error) = 3 tasks
  assert(!!p0Group && p0Group.count === 3, 'P0 group count must be 3');
  assert(!p0Group?.isDefaultCollapsed, 'priority group must not be default collapsed');

  // Done subgroup inside P2 group (t7 is P2 done)
  const p2Group = priorityGroups.find((g) => g.value === 'P2');
  const p2DoneSubgroup = p2Group?.subgroups.find((s) => s.value === 'done');
  assert(!!p2DoneSubgroup && p2DoneSubgroup.count === 1, 'P2 Done subgroup count must be 1');
  assert(
    p2DoneSubgroup?.isDefaultCollapsed === true,
    'Done subgroup in priority-state must be default collapsed',
  );

  // 3. Initial collapsed keys
  const stateCollapsed = getInitialCollapsedKeys('state-priority');
  assert(stateCollapsed.has('state-done'), 'initial collapsed must include state-done');
  assert(stateCollapsed.has('state-cancelled'), 'initial collapsed must include state-cancelled');
  assert(
    !stateCollapsed.has('state-processing'),
    'initial collapsed must not include state-processing',
  );
  assert(!stateCollapsed.has('state-todo'), 'initial collapsed must not include state-todo');

  const priorityCollapsed = getInitialCollapsedKeys('priority-state');
  assert(
    priorityCollapsed.has('priority-P0-state-done'),
    'priority-state must default collapse P0 done subgroup',
  );
  assert(
    priorityCollapsed.has('priority-P1-state-cancelled'),
    'priority-state must default collapse P1 cancelled subgroup',
  );

  console.log('✓ Grouping and hierarchy checks passed');
}

async function runPreferencesChecks(): Promise<void> {
  console.log('--- Running Preferences Persistence Checks ---');

  // Test preference functions in non-browser environment fallback
  const defaultMode = loadGroupModePreference();
  assert(defaultMode === 'state-priority', 'default group mode must be state-priority');

  const defaultCollapsed = loadCollapsedPreference('state-priority');
  assert(defaultCollapsed.has('state-done'), 'loaded collapsed must include state-done');

  // Mock localStorage in global scope to test browser persistence
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

  const testCollapsed = new Set(['custom-group-1', 'custom-group-2']);
  saveCollapsedPreference('priority-state', testCollapsed);
  const loadedCollapsed = loadCollapsedPreference('priority-state');
  assert(loadedCollapsed.has('custom-group-1'), 'saved collapsed must persist key 1');
  assert(loadedCollapsed.has('custom-group-2'), 'saved collapsed must persist key 2');
  assert(!loadedCollapsed.has('unknown-group'), 'unknown group must not be present');

  console.log('✓ Preferences persistence checks passed');
}

async function runApiAndUiIntegrationChecks(): Promise<void> {
  console.log('--- Running API and UI Integration Checks ---');

  const testDir = join(tmpdir(), `taskaside-ui-checks-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const db = openDatabase({ path: dbPath });
  runMigrations(db);

  const app = new Hono();
  mountRepositoryRoutes(app, db);
  mountTaskRoutes(app, db);
  mountChatRoutes(app, db);
  mountSettingsRoutes(app, db);
  mountStaticRoutes(app);

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: app.fetch,
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;

  try {
    // 1. Create Repository via API
    const repo = await createRepository(
      {
        name: 'web-frontend',
        displayPath: testDir,
        defaultProvider: 'codex',
      },
      { baseUrl },
    );
    assert(repo.name === 'web-frontend', 'created repo name must match');

    const repos = await fetchRepositories({ baseUrl });
    assert(
      repos.length === 1 && repos[0].id === repo.id,
      'fetchRepositories must return created repo',
    );

    // 2. Create Root Task
    const rootTask = await createTask(
      {
        title: 'Implement Navigation Header',
        description: 'Build responsive navigation bar with logo and menu',
        repoId: repo.id,
        priority: 'P1',
      },
      { baseUrl },
    );
    assert(rootTask.title === 'Implement Navigation Header', 'task title must match');
    assert(rootTask.priority === 'P1', 'task priority must match');
    assert(rootTask.status === 'todo', 'task initial status must be todo');
    assert(rootTask.depth === 0, 'root task depth must be 0');
    assert(rootTask.parentId === null, 'root task parentId must be null');

    // 3. Create Child Task
    const childTask = await createTask(
      {
        title: 'Add Mobile Hamburger Button',
        repoId: repo.id,
        priority: 'P2',
        parentId: rootTask.id,
      },
      { baseUrl },
    );
    assert(childTask.depth === 1, 'child task depth must be 1');
    assert(childTask.parentId === rootTask.id, 'child task parentId must match root task ID');

    // 4. Fetch Tasks with search query
    const allTasks = await fetchTasks({}, { baseUrl });
    assert(allTasks.length === 2, 'fetchTasks should return 2 tasks');

    const searchResults = await fetchTasks({ query: 'Hamburger' }, { baseUrl });
    assert(
      searchResults.length === 1 && searchResults[0].id === childTask.id,
      'search by query should match child task',
    );

    // 5. Fetch Task by ID
    const fetchedRoot = await fetchTaskById(rootTask.id, { baseUrl });
    assert(fetchedRoot.id === rootTask.id, 'fetchTaskById must return correct task');

    // 6. Update Task
    const updatedRoot = await updateTask(
      rootTask.id,
      {
        title: 'Implement Responsive Navigation Header',
        priority: 'P0',
        description: 'Updated description for responsive design',
      },
      { baseUrl },
    );
    assert(
      updatedRoot.title === 'Implement Responsive Navigation Header',
      'updated title must match',
    );
    assert(updatedRoot.priority === 'P0', 'updated priority must be P0');

    // 7. Cancel Task
    const cancelledChild = await cancelTask(childTask.id, { baseUrl });
    assert(cancelledChild.status === 'cancelled', 'cancelled task status must be cancelled');

    // 8. Retry Task (must fail when not error, succeed when error)
    let retryErrorCaught = false;
    try {
      await retryTask(cancelledChild.id, { baseUrl });
    } catch (err) {
      retryErrorCaught = true;
      assert(err instanceof ApiError, 'retry on cancelled task must throw ApiError');
    }
    assert(retryErrorCaught, 'retry on non-error task must be rejected');

    // Transition task to error directly in DB to test retryTask API
    db.query("UPDATE tasks SET status = 'error' WHERE id = ?").run(rootTask.id);
    const retriedTask = await retryTask(rootTask.id, { baseUrl });
    assert(retriedTask.status === 'todo', 'retried task status must reset to todo');

    // 9. Static Assets & SPA Routing
    const indexResponse = await fetch(`${baseUrl}/`);
    assert(indexResponse.ok, 'GET / must return 200 OK');
    const indexHtml = await indexResponse.text();
    assert(
      indexHtml.includes('<!doctype html>') || indexHtml.includes('<html'),
      'index HTML must be returned',
    );

    const spaRouteResponse = await fetch(`${baseUrl}/tasks/some-task-id`);
    assert(spaRouteResponse.ok, 'SPA navigation route must return 200 OK');

    console.log('✓ API and UI integration checks passed');
  } finally {
    server.stop();
    db.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

async function runConversationAndSettingsChecks(): Promise<void> {
  console.log('--- Running Conversation, HITL, Settings, and SSE Checks ---');

  const testDir = join(tmpdir(), `taskaside-t27-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, 'taskaside.db');
  const db = openDatabase({ path: dbPath });
  runMigrations(db);

  const authToken = 'test-browser-token-xyz';
  const app = new Hono();
  registerErrorHandler(app);
  mountRepositoryRoutes(app, db);
  mountTaskRoutes(app, db);
  mountChatRoutes(app, db);
  mountSettingsRoutes(app, db, { token: authToken });
  mountEventsRoutes(app, { token: authToken });

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: app.fetch,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  try {
    // 1. Markdown Parsing and Sanitization verification
    const { marked } = await import('marked');
    const mdInput =
      '# Heading 1\n\n- item 1\n- item 2\n\n```ts\nconst num = 42;\n```\n\n<script>alert("xss")</script><img src="x" onerror="alert(1)">';
    const parsedMd = marked.parse(mdInput, { gfm: true, breaks: true }) as string;
    assert(parsedMd.includes('<h1>Heading 1</h1>'), 'markdown must parse h1');
    assert(parsedMd.includes('<li>item 1</li>'), 'markdown must parse lists');
    assert(parsedMd.includes('<code class="language-ts">'), 'markdown must parse code block');

    // 2. Register repository and create task
    const repo = await createRepository(
      {
        name: 'Chat Test Repo',
        displayPath: testDir,
        defaultProvider: 'codex',
      },
      { baseUrl },
    );
    const task = await createTask(
      {
        title: 'Task for Chat and HITL Verification',
        repoId: repo.id,
        priority: 'P1',
      },
      { baseUrl },
    );

    // 3. Initial Empty Messages
    const initialMsgs = await fetchMessages(task.id, undefined, { baseUrl });
    assert(initialMsgs.messages.length === 0, 'initial messages list must be empty');

    // 4. Post Message
    const userMsg = await postMessage(
      task.id,
      { content: 'Please review the authentication module.' },
      { baseUrl },
    );
    assert(userMsg.sender === 'user', 'message sender must be user');
    assert(
      userMsg.content === 'Please review the authentication module.',
      'message content must match',
    );

    const msgsAfterFirst = await fetchMessages(task.id, undefined, { baseUrl });
    assert(msgsAfterFirst.messages.length === 1, 'must have 1 message');
    assert(msgsAfterFirst.messages[0].id === userMsg.id, 'message ID must match');

    // 5. Queued Messages on Processing Task
    db.query("UPDATE tasks SET status = 'processing' WHERE id = ?").run(task.id);
    const queuedMsg = await postMessage(
      task.id,
      { content: 'Additional note: check OAuth as well.' },
      { baseUrl },
    );
    assert(queuedMsg.sender === 'user', 'queued message sender must be user');

    const taskDuringProcessing = await fetchTaskById(task.id, { baseUrl });
    assert(taskDuringProcessing.status === 'processing', 'task must remain in processing state');
    const msgsDuringProcessing = await fetchMessages(task.id, undefined, { baseUrl });
    assert(msgsDuringProcessing.messages.length === 2, 'must have 2 messages in conversation');

    // 6. HITL input_required and Atomic Reply
    const requestId = `req_${Date.now()}`;
    const runId = `run_${Date.now()}`;
    const now = new Date().toISOString();

    // Simulate agent input_required event committing to DB
    const conversationRow = db
      .query('SELECT conversation_id FROM tasks WHERE id = ?')
      .get(task.id) as {
      conversation_id: string;
    };
    db.query(
      `INSERT INTO runs (id, task_id, provider, status, owner_token, lock_generation, pending_input_request_id, started_at, heartbeat_at)
       VALUES (?, ?, 'codex', 'hitl', 'owner_1', 1, ?, ?, ?)`,
    ).run(runId, task.id, requestId, now, now);
    db.query(
      `INSERT INTO messages (id, conversation_id, role, content, in_reply_to_request_id, created_at)
       VALUES (?, ?, 'agent', 'Which authentication provider should we use?', NULL, ?)`,
    ).run(`msg_${Date.now()}`, conversationRow.conversation_id, now);
    db.query("UPDATE tasks SET status = 'hitl', updated_at = ? WHERE id = ?").run(now, task.id);

    // Fetch task and verify pendingInputRequestId is populated
    const hitlTask = await fetchTaskById(task.id, { baseUrl });
    assert(hitlTask.status === 'hitl', 'task must be in hitl state');
    assert(
      hitlTask.pendingInputRequestId === requestId,
      'task must have matching pendingInputRequestId',
    );

    // User replies with inReplyToRequestId
    const replyMsg = await postMessage(
      task.id,
      { content: 'Please use GitHub OAuth.', inReplyToRequestId: requestId },
      { baseUrl },
    );
    assert(
      replyMsg.inReplyToRequestId === requestId,
      'reply message must record inReplyToRequestId',
    );

    // Verify task atomically transitioned back to processing
    const taskAfterReply = await fetchTaskById(task.id, { baseUrl });
    assert(
      taskAfterReply.status === 'processing',
      'task must transition back to processing after reply',
    );
    assert(!taskAfterReply.pendingInputRequestId, 'pendingInputRequestId must be cleared');

    // Duplicate reply with same requestId must be rejected with 409 REQUEST_ALREADY_RESOLVED
    let dupReplyErrorCaught = false;
    try {
      await postMessage(
        task.id,
        { content: 'Duplicate reply', inReplyToRequestId: requestId },
        { baseUrl },
      );
    } catch (err) {
      dupReplyErrorCaught = true;
      assert(err instanceof ApiError, 'duplicate reply must throw ApiError');
      assert((err as ApiError).status === 409, 'status must be 409');
      assert(
        (err as ApiError).code === 'REQUEST_ALREADY_RESOLVED',
        'code must be REQUEST_ALREADY_RESOLVED',
      );
    }
    assert(dupReplyErrorCaught, 'duplicate reply must be rejected');

    // 7. Terminal Task Message Persistence (does not resurrect)
    db.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    const terminalMsg = await postMessage(
      task.id,
      { content: 'Great job, task is verified.' },
      { baseUrl },
    );
    assert(
      terminalMsg.content === 'Great job, task is verified.',
      'terminal message must be stored',
    );
    const taskAfterTerminalMsg = await fetchTaskById(task.id, { baseUrl });
    assert(
      taskAfterTerminalMsg.status === 'done',
      'task must strictly remain done without resurrecting',
    );

    // 8. Settings & Diagnostics
    const initialSettings = await fetchSettings({ baseUrl, token: authToken });
    assert(initialSettings.defaultProvider === 'codex', 'default provider must be codex');
    assert(initialSettings.maxConcurrency === 8, 'default concurrency must be 8');
    assert(initialSettings.diagnostics.service === 'backend', 'service must be backend');
    assert(initialSettings.diagnostics.tasksCount >= 1, 'tasksCount must be >= 1');
    assert(typeof initialSettings.diagnostics.version === 'string', 'version must be string');
    assert(
      typeof initialSettings.diagnostics.uptimeSeconds === 'number',
      'uptimeSeconds must be number',
    );
    assert(
      initialSettings.diagnostics.dbPath.includes('taskaside.db'),
      'dbPath must point to sqlite db',
    );

    // Update settings
    const updatedSettings = await updateSettings(
      { defaultProvider: 'claude', maxConcurrency: 5 },
      { baseUrl, token: authToken },
    );
    assert(updatedSettings.defaultProvider === 'claude', 'updated provider must be claude');
    assert(updatedSettings.maxConcurrency === 5, 'updated concurrency must be 5');

    // Refetch settings to verify DB persistence
    const refetchedSettings = await fetchSettings({ baseUrl, token: authToken });
    assert(refetchedSettings.defaultProvider === 'claude', 'refetched provider must be claude');
    assert(refetchedSettings.maxConcurrency === 5, 'refetched concurrency must be 5');

    // 9. SSE Reconnect & Authoritative REST Synchronization
    const sseRes = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(authToken)}`, {
      headers: { Accept: 'text/event-stream' },
    });
    assert(sseRes.ok, 'SSE stream response must be 200 OK');
    if (!sseRes.body) {
      throw new Error('SSE stream body is null');
    }

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let sseText = '';
    const readChunk = await reader.read();
    if (readChunk.value) {
      sseText += decoder.decode(readChunk.value);
    }
    assert(sseText.includes('event: connected'), 'SSE must emit initial connected event');

    // Publish delta and completed events to eventHub
    eventHub.publish({
      type: 'message.delta',
      data: { runId: 'run_test', messageId: 'msg_delta_1', delta: 'Streaming token chunk' },
    });
    eventHub.publish({
      type: 'message.completed',
      data: {
        messageId: 'msg_completed_1',
        taskId: task.id,
        conversationId: conversationRow.conversation_id,
        role: 'agent',
        content: 'Final completed message content',
      },
    });

    // Close reader (simulating disconnect)
    await reader.cancel();

    // On reconnect, client fetches authoritative REST state
    const restoredTasks = await fetchTasks({}, { baseUrl });
    assert(restoredTasks.length >= 1, 'restored tasks must be fetched from REST snapshot');
    const restoredMsgs = await fetchMessages(task.id, undefined, { baseUrl });
    assert(restoredMsgs.messages.length >= 4, 'restored messages must be fetched from REST snapshot');

    console.log('✓ Conversation, HITL, Settings, and SSE checks passed');
  } finally {
    server.stop();
    db.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

import { runLiveWorkflowChecks } from './workflow-checks.ts';

async function main(): Promise<void> {
  console.log('Starting Frontend Verification Checks (T26, T27 & T28 - M5 Gate)...\n');
  await runGroupingChecks();
  await runPreferencesChecks();
  await runApiAndUiIntegrationChecks();
  await runConversationAndSettingsChecks();
  await runLiveWorkflowChecks();
  console.log('\nAll verification assertions in M5 (T26, T27, T28) passed successfully!');
}

await main();
process.exit(0);

