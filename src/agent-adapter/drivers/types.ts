import type {
  EventEnvelope,
  ProvideInputRequest,
  Provider,
  VerificationMethod,
} from '../../contracts/index.ts';
import type { AdapterRun } from '../types.ts';

export interface DriverCallbacks {
  onEvent: (event: EventEnvelope) => void;
  onEnd: () => void;
  onSessionId?: (sessionId: string) => void;
  /** Reported as soon as the spawned process group's pid is known (LC-05c-p),
   * so the manager can journal the launch before any events arrive. */
  onProcessGroupPid?: (pgid: number) => void;
}

export interface DriverCancelResult {
  verifiedStopped: boolean;
  verificationMethod: VerificationMethod;
}

export interface AgentDriver {
  readonly provider: Provider;
  start(run: AdapterRun, callbacks: DriverCallbacks): Promise<void>;
  cancel(run: AdapterRun): Promise<DriverCancelResult>;
  provideInput?(run: AdapterRun, req: ProvideInputRequest): Promise<{ ok: boolean }>;
}
