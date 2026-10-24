import type { EventEnvelope, Provider, RunStatus, VerificationMethod } from '../contracts/index.ts';

export type FakeScenario =
  'success' | 'failure' | 'hitl' | 'duplicate_events' | 'disconnect' | 'crash';

export interface AdapterRun {
  runId: string;
  taskId: string;
  provider: Provider;
  cwd: string;
  instruction: string;
  ownerId: string;
  generation: number;
  sessionId?: string;
  mcp?: { endpoint: string; accessToken: string };
  scenario?: FakeScenario;
  status: RunStatus;
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
}
