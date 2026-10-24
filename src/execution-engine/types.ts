// Execution engine types and interfaces (ARCHITECTURE.md §2.2, §5; SPECIFICATION.md §2, §3, §5).
import type { Message } from '../contracts/chat.ts';
import type {
  ClaimTaskRequest,
  ClaimTaskResponse,
  FinalizeRunRequest,
  HeartbeatRequest,
  MarkUncertainRequest,
} from '../contracts/run.ts';
import type { Settings } from '../contracts/settings.ts';
import type { Repository, Task, TaskPriority } from '../contracts/task.ts';

export interface TaskRecord extends Task {
  conversationId?: string;
  enqueuedAt?: string;
  repositoryId?: string;
  originRunId?: string | null;
  idempotencyKey?: string | null;
}

export interface ChildTaskSummary {
  id: string;
  title: string;
  status: string;
  summary: string | null;
  errorMessage: string | null;
}

export interface TaskContext {
  task: TaskRecord;
  repository: Repository;
  parent: TaskRecord | null;
  conversation: { id: string; createdAt: string; updatedAt: string } | null;
  messages: Message[];
  children?: ChildTaskSummary[];
}

export interface ActiveRun {
  runId: string;
  taskId: string;
  workingTreeKey: string;
  generation: number;
  priority: TaskPriority;
  startedAt: string;
}

export interface SchedulerOptions {
  ownerId: string;
  maxConcurrency?: number;
  pollIntervalMs?: number;
}

export interface InstructionOptions {
  maxHistoryMessages?: number;
  maxHistoryCharacters?: number;
  includeSafetyGuidelines?: boolean;
}

export type FetchLike = (input: Request) => Promise<Response> | Response;

export interface BackendClientOptions {
  baseUrl: string;
  internalToken: string;
  role?: 'engine' | 'supervisor';
  fetch?: FetchLike;
}

export interface AdapterClientOptions {
  baseUrl: string;
  internalToken: string;
  role?: 'engine' | 'supervisor';
  fetch?: FetchLike;
}

export interface IngestEventsResponse {
  ok: boolean;
  acknowledgedSequences?: number[];
  count?: number;
}

export interface DispatcherOptions {
  ownerId: string;
  deltaCoalesceMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  heartbeatIntervalMs?: number;
}

export interface StartRunResult {
  runId: string;
  started: boolean;
  existing?: boolean;
}

export interface CancelRunResult {
  runId: string;
  verifiedStopped: boolean;
  verificationMethod?: 'process_group_empty' | 'ps_fingerprint_absent';
}

export interface DispatchResult {
  runId: string;
  taskId: string;
  status: 'done' | 'error' | 'cancelled' | 'hitl' | 'uncertain';
  lastSequence: number;
  verifiedStopped: boolean;
  verificationMethod?: 'process_group_empty' | 'ps_fingerprint_absent';
}

export interface ScheduleStepResult {
  claimed: boolean;
  taskId?: string;
  runId?: string;
  workingTreeKey?: string;
  generation?: number;
  skippedReason?: 'concurrency_limit_reached' | 'no_runnable_tasks' | 'all_trees_busy';
  error?: string;
}

export interface ReconcileRunResult {
  runId: string;
  reconciled: boolean;
  status: string;
  quarantined: boolean;
  verifiedStopped: boolean;
  error?: string;
}

export interface CancelAndReconcileResult {
  runId: string;
  cancelled: boolean;
  verifiedStopped: boolean;
  quarantined: boolean;
  status: 'cancelled' | 'uncertain';
}

export interface ReconcilerOptions {
  ownerId: string;
}

export interface RunStatusRecord {
  runId: string;
  taskId: string;
  provider: string;
  status: 'running' | 'hitl' | 'done' | 'error' | 'cancelled' | 'uncertain';
  ownerId: string;
  generation: number;
  pendingInputRequestId: string | null;
  startedAt: string;
  heartbeatAt: string;
  endedAt: string | null;
  exitCode: number | null;
  processState: unknown;
  cancelRequestedAt?: string | null;
  deadlineAt: string;
  timeoutRequestedAt?: string | null;
}

export interface HitlCoordinatorOptions {
  ownerId: string;
}

export interface ResumeHitlParams {
  task: TaskRecord;
  claim: { runId: string; generation: number; [key: string]: unknown };
  context: TaskContext;
  response: string;
  requestId?: string;
  provider?: 'codex' | 'claude';
  sessionId?: string;
  scenario?: string;
}
