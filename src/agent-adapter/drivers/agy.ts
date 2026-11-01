// Antigravity (agy) driver implementation (ARCHITECTURE.md §6).
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type {
  EventEnvelope,
  ProvideInputRequest,
  VerificationMethod,
} from '../../contracts/index.ts';
import { AdapterError } from '../errors.ts';
import type { AdapterRun } from '../types.ts';
import { terminateProcessGroup } from './process-group.ts';
import type { AgentDriver, DriverCallbacks, DriverCancelResult } from './types.ts';

export interface AgyRawEvent {
  type?: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  message?: {
    id?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  result?: string;
  is_error?: boolean;
  error?: string;
  conversation_id?: string;
  timestamp?: string;
}

export function parseAgyJsonLine(line: string): AgyRawEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as AgyRawEvent;
  } catch {
    return null;
  }
}

export function buildAgyArgs(run: AdapterRun): {
  args: string[];
  env: Record<string, string>;
  assignedSessionId?: string;
} {
  const args: string[] = [
    '--print',
    run.instruction,
    '--sandbox',
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
  ];

  let assignedSessionId: string | undefined;
  if (run.sessionId) {
    args.push('--conversation', run.sessionId);
  } else {
    assignedSessionId = randomUUID();
  }

  const env: Record<string, string> = {};
  if (run.mcp) {
    env.TASKASIDE_MCP_URL = run.mcp.endpoint;
    env.TASKASIDE_MCP_TOKEN = run.mcp.accessToken;
  }

  return { args, env, assignedSessionId };
}

export class AgyDriver implements AgentDriver {
  readonly provider = 'agy' as const;
  private agyPath: string;
  private activeProcesses = new Map<
    string,
    { child: ChildProcess; pgid: number; wasCancelled: boolean }
  >();

  constructor(options: { agyPath?: string } = {}) {
    this.agyPath = options.agyPath ?? Bun.which('agy') ?? 'agy';
  }

  async start(run: AdapterRun, callbacks: DriverCallbacks): Promise<void> {
    const { args, env, assignedSessionId } = buildAgyArgs(run);

    if (assignedSessionId && !run.sessionId) {
      run.sessionId = assignedSessionId;
      if (callbacks.onSessionId) {
        callbacks.onSessionId(assignedSessionId);
      }
    }

    try {
      appendFileSync(
        run.logPath,
        `[${new Date().toISOString()}] Launching agy: ${this.agyPath} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`,
      );
    } catch {
      // ignore log append error
    }

    const child = spawn(this.agyPath, args, {
      cwd: run.cwd,
      detached: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pgid = child.pid;
    if (!pgid) {
      throw new AdapterError('VALIDATION_ERROR', 'Failed to obtain process PID from child');
    }

    run.processGroupPid = pgid;
    const procRecord = { child, pgid, wasCancelled: false };
    this.activeProcesses.set(run.runId, procRecord);
    callbacks.onProcessGroupPid?.(pgid);

    let stdoutBuffer = '';
    let seq = run.lastSequence;
    let terminalEventEmitted = false;
    let lastAgentMessage = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const raw = parseAgyJsonLine(line);
        if (!raw) {
          if (line.trim().length > 0) {
            lastAgentMessage = line.trim();
          }
          continue;
        }

        if (raw.conversation_id) {
          run.sessionId = raw.conversation_id;
          if (callbacks.onSessionId) {
            callbacks.onSessionId(raw.conversation_id);
          }
        }

        let textContent = '';
        if (typeof raw.content === 'string') {
          textContent = raw.content;
        } else if (Array.isArray(raw.content)) {
          textContent = raw.content
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string)
            .join('\n');
        } else if (raw.message?.content) {
          if (typeof raw.message.content === 'string') {
            textContent = raw.message.content;
          } else if (Array.isArray(raw.message.content)) {
            textContent = raw.message.content
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('\n');
          }
        }

        if (textContent.trim().length > 0) {
          lastAgentMessage = textContent;
          seq += 1;
          callbacks.onEvent({
            runId: run.runId,
            sequence: seq,
            type: 'message.completed',
            timestamp: raw.timestamp || new Date().toISOString(),
            data: {
              messageId: raw.message?.id || `msg_${seq}`,
              content: textContent,
            },
          });
        }

        if (raw.type === 'result' || raw.result !== undefined) {
          terminalEventEmitted = true;
          const isError = Boolean(raw.is_error || raw.error);
          seq += 1;
          if (isError) {
            callbacks.onEvent({
              runId: run.runId,
              sequence: seq,
              type: 'failed',
              timestamp: raw.timestamp || new Date().toISOString(),
              data: {
                errorCode: 'AGENT_ERROR',
                message: raw.error || raw.result || 'Agy run failed',
              },
            });
          } else {
            callbacks.onEvent({
              runId: run.runId,
              sequence: seq,
              type: 'completed',
              timestamp: raw.timestamp || new Date().toISOString(),
              data: {
                summary: raw.result || lastAgentMessage || 'Task completed',
              },
            });
          }
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      try {
        appendFileSync(run.logPath, chunk.toString('utf8'));
      } catch {
        // ignore log error
      }
    });

    child.on('close', (code, signal) => {
      this.activeProcesses.delete(run.runId);

      if (procRecord.wasCancelled) {
        if (!terminalEventEmitted) {
          seq += 1;
          callbacks.onEvent({
            runId: run.runId,
            sequence: seq,
            type: 'cancelled',
            timestamp: new Date().toISOString(),
            data: {},
          });
        }
      } else if (!terminalEventEmitted) {
        seq += 1;
        if (code === 0) {
          callbacks.onEvent({
            runId: run.runId,
            sequence: seq,
            type: 'completed',
            timestamp: new Date().toISOString(),
            data: {
              summary: lastAgentMessage || 'Task completed successfully',
            },
          });
        } else {
          callbacks.onEvent({
            runId: run.runId,
            sequence: seq,
            type: 'failed',
            timestamp: new Date().toISOString(),
            data: {
              errorCode: signal ? `SIGNAL_${signal}` : `EXIT_${code ?? 1}`,
              message: `Agy process exited with code ${code ?? 1}${signal ? ` (signal ${signal})` : ''}`,
            },
          });
        }
      }

      callbacks.onEnd();
    });
  }

  async cancel(run: AdapterRun): Promise<DriverCancelResult> {
    const proc = this.activeProcesses.get(run.runId);
    if (!proc) {
      return { verifiedStopped: true, verificationMethod: 'process_group_empty' };
    }

    proc.wasCancelled = true;
    const pgid = proc.pgid;
    return await terminateProcessGroup(pgid);
  }

  async provideInput(run: AdapterRun, _req: ProvideInputRequest): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
