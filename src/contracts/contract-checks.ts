// Executable contract verification suite. Run: bun run src/contracts/contract-checks.ts
import {
  CancelRunRequestSchema,
  CapabilitiesResponseSchema,
  ClaimTaskRequestSchema,
  CreateMessageInputSchema,
  CreateTaskInputSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  FinalizeRunRequestSchema,
  HeartbeatRequestSchema,
  ListTasksParamsSchema,
  MAX_CHILDREN_PER_TASK,
  MessageSchema,
  PostMessageParamsSchema,
  TaskSchema,
  canCreateChildTask,
  computeEventHash,
  isWithinChildLimit,
} from './index.ts';

type CheckResult = { name: string; passed: boolean; error?: string };

const results: CheckResult[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// --- Fixtures -------------------------------------------------------------

const validTask = {
  id: 'task_01',
  title: 'Implement login validation',
  description: 'Add server-side validation',
  repoId: 'repo_01',
  status: 'todo' as const,
  priority: 'P1' as const,
  parentId: null,
  depth: 0 as const,
  createdAt: '2026-10-18T09:00:00Z',
  updatedAt: '2026-10-18T09:00:00Z',
  blockedReason: null,
  blockedOnChildIds: null,
  activeRunId: null,
  version: 0,
};

const validMessage = {
  id: 'msg_01',
  taskId: 'task_01',
  conversationId: 'conv_01',
  sender: 'agent' as const,
  content: 'Implemented login validation.',
  inReplyToRequestId: null,
  createdAt: '2026-10-18T09:00:00Z',
};

const validEnvelope = {
  runId: 'run_01',
  sequence: 1,
  type: 'message.completed' as const,
  timestamp: '2026-10-18T09:00:00Z',
  data: { messageId: 'msg_01', content: 'Implemented login validation.' },
};

// --- Positive checks --------------------------------------------------------

check('positive: valid task parses', () => {
  TaskSchema.parse(validTask);
});

check('positive: valid create task input parses', () => {
  CreateTaskInputSchema.parse({
    title: 'New task',
    repoId: 'repo_01',
    priority: 'P2',
  });
});

check('positive: valid chat message parses', () => {
  MessageSchema.parse(validMessage);
});

check('positive: valid create message input parses', () => {
  CreateMessageInputSchema.parse({ content: 'hello' });
});

check('positive: valid run claim request parses', () => {
  ClaimTaskRequestSchema.parse({
    ownerId: 'engine_01',
    generation: 1,
    idempotencyKey: 'idem_01',
  });
});

check('positive: valid heartbeat request parses', () => {
  HeartbeatRequestSchema.parse({ ownerId: 'engine_01', generation: 1 });
});

check('positive: valid terminal finalize request parses', () => {
  FinalizeRunRequestSchema.parse({
    ownerId: 'engine_01',
    generation: 1,
    status: 'done',
    verifiedStopped: true,
    verificationMethod: 'process_group_empty',
    summary: 'All good',
  });
});

check('positive: valid flat event envelope parses', () => {
  EventEnvelopeSchema.parse(validEnvelope);
});

check('positive: valid cancel run request with optional fields omitted', () => {
  CancelRunRequestSchema.parse({});
});

check('positive: valid capabilities response parses', () => {
  CapabilitiesResponseSchema.parse({
    providers: {
      codex: { available: true, resume: false, mcp: false },
      claude: { available: true, resume: true, mcp: true },
    },
  });
});

check('positive: MCP list_tasks params parse', () => {
  ListTasksParamsSchema.parse({ status: 'todo', limit: 20, offset: 0 });
});

check('positive: MCP post_message params parse', () => {
  PostMessageParamsSchema.parse({ content: 'status update' });
});

// --- Negative checks --------------------------------------------------------

check("negative: rejects invalid task status 'needs_review'", () => {
  const result = TaskSchema.safeParse({ ...validTask, status: 'needs_review' });
  assert(!result.success, "expected rejection of status 'needs_review'");
});

check("negative: rejects invalid task status 'pending'", () => {
  const result = TaskSchema.safeParse({ ...validTask, status: 'pending' });
  assert(!result.success, "expected rejection of status 'pending'");
});

check("negative: rejects invalid priority 'P4'", () => {
  const result = TaskSchema.safeParse({ ...validTask, priority: 'P4' });
  assert(!result.success, "expected rejection of priority 'P4'");
});

check("negative: rejects invalid priority 'high'", () => {
  const result = TaskSchema.safeParse({ ...validTask, priority: 'high' });
  assert(!result.success, "expected rejection of priority 'high'");
});

check('negative: rejects negative sequence', () => {
  const result = EventEnvelopeSchema.safeParse({
    ...validEnvelope,
    sequence: -1,
  });
  assert(!result.success, 'expected rejection of negative sequence');
});

check('negative: rejects event envelope missing required fields', () => {
  const result = EventEnvelopeSchema.safeParse({
    type: 'message.completed',
    data: { messageId: 'msg_01', content: 'x' },
  });
  assert(!result.success, 'expected rejection of envelope missing runId/sequence/timestamp');
});

check('negative: rejects mismatched event data for type', () => {
  const result = EventEnvelopeSchema.safeParse({
    runId: 'run_01',
    sequence: 1,
    type: 'message.completed',
    timestamp: '2026-10-18T09:00:00Z',
    data: { requestId: 'req_01', question: 'mismatched shape' },
  });
  assert(!result.success, 'expected rejection of data shape mismatched with type');
});

check('negative: rejects finalize with verifiedStopped:false on terminal status', () => {
  const result = FinalizeRunRequestSchema.safeParse({
    ownerId: 'engine_01',
    generation: 1,
    status: 'done',
    verifiedStopped: false,
  });
  assert(!result.success, 'expected rejection of unverified stop on terminal status');
});

check('negative: rejects finalize missing verificationMethod on terminal status', () => {
  const result = FinalizeRunRequestSchema.safeParse({
    ownerId: 'engine_01',
    generation: 1,
    status: 'error',
    verifiedStopped: true,
  });
  assert(!result.success, 'expected rejection of missing verificationMethod');
});

check('negative: rejects claim request missing ownerId/generation', () => {
  const result = ClaimTaskRequestSchema.safeParse({
    idempotencyKey: 'idem_01',
  });
  assert(!result.success, 'expected rejection of missing ownerId/generation');
});

check('negative: rejects heartbeat request missing generation', () => {
  const result = HeartbeatRequestSchema.safeParse({ ownerId: 'engine_01' });
  assert(!result.success, 'expected rejection of missing generation');
});

// --- Idempotent event hash ---------------------------------------------------

check('hash: identical event payloads produce identical sha256 hash', () => {
  const a: EventEnvelope = validEnvelope;
  const b: EventEnvelope = { ...validEnvelope };
  assert(
    computeEventHash(a) === computeEventHash(b),
    'expected identical hash for identical payloads',
  );
});

check('hash: changed payload produces different hash', () => {
  const a: EventEnvelope = validEnvelope;
  const b: EventEnvelope = {
    ...validEnvelope,
    data: { messageId: 'msg_01', content: 'different content' },
  };
  assert(
    computeEventHash(a) !== computeEventHash(b),
    'expected different hash for different payload',
  );
});

check('hash: key order does not affect hash (canonical JSON)', () => {
  const a: EventEnvelope = validEnvelope;
  const b: EventEnvelope = {
    timestamp: a.timestamp,
    type: a.type,
    sequence: a.sequence,
    runId: a.runId,
    data: { content: a.data.content, messageId: a.data.messageId },
  } as EventEnvelope;
  assert(
    computeEventHash(a) === computeEventHash(b),
    'expected key-order independence in canonical hash',
  );
});

// --- Child constraints --------------------------------------------------------

check('child: depth 0 task can create a child', () => {
  assert(canCreateChildTask(0), 'expected depth 0 to permit child creation');
});

check('child: depth 1 task cannot create a grandchild', () => {
  assert(!canCreateChildTask(1), 'expected depth 1 to forbid child creation');
});

check('child: within limit when fewer than max children', () => {
  assert(
    isWithinChildLimit(MAX_CHILDREN_PER_TASK - 1),
    'expected count below ceiling to be within limit',
  );
});

check('child: rejects at/over the 5-child ceiling', () => {
  assert(!isWithinChildLimit(MAX_CHILDREN_PER_TASK), 'expected count at ceiling to be rejected');
});

// --- Report -------------------------------------------------------------

const failed = results.filter((r) => !r.passed);

for (const result of results) {
  const marker = result.passed ? 'PASS' : 'FAIL';
  console.log(`[${marker}] ${result.name}${result.error ? ` — ${result.error}` : ''}`);
}

console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

if (failed.length > 0) {
  process.exit(1);
}
