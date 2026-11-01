import type {
  EventEnvelope,
  Provider,
  RunOutcome,
  RunStatus,
  VerificationMethod,
} from '../contracts/index.ts';
import type { RunEventStream } from './event-stream.ts';

export type FakeScenario =
  'success' | 'failure' | 'hitl' | 'duplicate_events' | 'disconnect' | 'crash';

export interface AdapterRun {
  runId: string;
  taskId: string;
  purpose: 'intake' | 'implementation';
  provider: Provider;
  cwd: string;
  writeRoots: string[];
  instruction: string;
  ownerId: string;
  generation: number;
  runFence: number;
  lockGenerations?: Record<string, number>;
  sessionId?: string;
  mcp?: { endpoint: string; accessToken: string };
  scenario?: FakeScenario;
  status: RunStatus;
  outcome?: RunOutcome;
  events: EventEnvelope[];
  lastSequence: number;
  pendingRequestId: string | null;
  verifiedStoppedAt: string | null;
  verificationMethod: VerificationMethod | null;
  exitCode: number | null;
  createdAt: string;
  subscribers: Set<(event: EventEnvelope) => void>;
  onEndSubscribers: Set<() => void>;
  processGroupPid?: number;
  logPath: string;
  deadlineAt?: string;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  stream?: RunEventStream;
}
