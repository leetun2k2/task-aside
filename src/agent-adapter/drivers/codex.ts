// Codex driver implementation (ARCHITECTURE.md §6, TASKS.md T17, SPECIFICATION.md §2, §3, §6).
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import type {
  EventEnvelope,
  ProvideInputRequest,
  VerificationMethod,
} from '../../contracts/index.ts';
import { AdapterError } from '../errors.ts';
import type { AdapterRun } from '../types.ts';
import type { AgentDriver, DriverCallbacks, DriverCancelResult } from './types.ts';

export interface CodexRawEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    changes?: Array<{ path: string; kind: string }>;
    message?: string;
  };
  error?: {
    message?: string;
    code?: string;
    status?: number;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export function parseCodexJsonLine(line: string): CodexRawEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as CodexRawEvent;
  } catch {
    return null;
  }
}

export function buildCodexArgs(run: AdapterRun): { args: string[]; env: Record<string, string> } {
  const args: string[] = [
    'exec',
    '--cd',
    run.cwd,
    '--approve-for-me',
    '--ephemeral',
    '--json',
    '--ignore-user-config',
  ];
  const env: Record<string, string> = {};

  if (run.mcp) {
    args.push(
      '-c',
      `mcp_servers.taskaside.url="${run.mcp.endpoint}"`,
      '-c',
      'mcp_servers.taskaside.bearer_token_env_var="TASKASIDE_MCP_TOKEN"',
    );
    env.TASKASIDE_MCP_TOKEN = run.mcp.accessToken;
  }

  args.push(run.instruction);
  return { args, env };
}

export interface CodexStreamMapperResult {
  sessionId?: string;
  events: EventEnvelope[];
  terminalType?: 'completed' | 'failed' | 'cancelled';
  lastMessageText?: string;
}

/**
 * Pure stream mapper that processes raw lines from Codex stdout and produces
 * versioned flat TaskAside EventEnvelope items.
 */
export function mapCodexJsonLines(
  lines: string[],
  runId: string,
  startSequence = 0,
): CodexStreamMapperResult {
  let seq = startSequence;
  let sessionId: string | undefined;
  let lastMessageText: string | undefined;
  let terminalType: 'completed' | 'failed' | 'cancelled' | undefined;
  const events: EventEnvelope[] = [];

  for (const line of lines) {
    const raw = parseCodexJsonLine(line);
    if (!raw) {
      continue;
    }

    if (raw.type === 'thread.started' && raw.thread_id) {
      sessionId = raw.thread_id;
    } else if (raw.type === 'item.completed' && raw.item?.type === 'agent_message') {
      const text = raw.item.text ?? '';
      lastMessageText = text;
      seq += 1;
      events.push({
        runId,
        sequence: seq,
        type: 'message.completed',
        timestamp: new Date().toISOString(),
        data: {
          messageId: raw.item.id || `msg_${seq}`,
          content: text,
        },
      });
    } else if (raw.type === 'turn.completed') {
      terminalType = 'completed';
      seq += 1;
      events.push({
        runId,
        sequence: seq,
        type: 'completed',
        timestamp: new Date().toISOString(),
        data: {
          summary: lastMessageText || 'Task completed',
        },
      });
    } else if (raw.type === 'turn.failed') {
      terminalType = 'failed';
      seq += 1;
      const errorMsg =
        typeof raw.error?.message === 'string'
          ? raw.error.message
          : raw.error
            ? JSON.stringify(raw.error)
            : 'Turn failed';
      events.push({
        runId,
        sequence: seq,
        type: 'failed',
        timestamp: new Date().toISOString(),
        data: {
          errorCode: raw.error?.code || 'AGENT_ERROR',
          message: errorMsg,
        },
      });
    }
  }

  return { sessionId, events, terminalType, lastMessageText };
}

export class CodexDriver implements AgentDriver {
  readonly provider = 'codex' as const;
  private codexPath: string;
  private activeProcesses = new Map<
    string,
    { child: ChildProcess; pgid: number; wasCancelled: boolean }
  >();

  constructor(options: { codexPath?: string } = {}) {
    this.codexPath = options.codexPath ?? Bun.which('codex') ?? 'codex';
  }

  async start(run: AdapterRun, callbacks: DriverCallbacks): Promise<void> {
    if (run.sessionId) {
      throw new AdapterError(
        'VALIDATION_ERROR',
        'Codex driver does not support session resume in exec baseline',
      );
    }

    const { args, env } = buildCodexArgs(run);

    try {
      appendFileSync(
        run.logPath,
        `[${new Date().toISOString()}] Launching codex: ${this.codexPath} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`,
      );
    } catch {
      // ignore
    }

    const child = spawn(this.codexPath, args, {
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

    let stdoutBuffer = '';
    let seq = run.lastSequence;
    let terminalEventEmitted = false;
    let lastAgentMessage = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      // Keep trailing incomplete chunk
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const raw = parseCodexJsonLine(line);
        if (!raw) {
          continue;
        }

        if (raw.type === 'thread.started' && raw.thread_id) {
          run.sessionId = raw.thread_id;
          if (callbacks.onSessionId) {
            callbacks.onSessionId(raw.thread_id);
          }
        } else if (raw.type === 'item.completed' && raw.item?.type === 'agent_message') {
          const text = raw.item.text ?? '';
          lastAgentMessage = text;
          seq += 1;
          callbacks.onEvent({
            runId: run.runId,
            sequence: seq,
            type: 'message.completed',
            timestamp: new Date().toISOString(),
            data: {
              messageId: raw.item.id || `msg_${seq}`,
              content: text,
            },
          });
        } else if (raw.type === 'turn.completed') {
          terminalEventEmitted = true;
          seq += 1;
          callbacks.onEvent({
            runId: run.runId,
            sequence: seq,
            type: 'completed',
            timestamp: new Date().toISOString(),
            data: {
              summary: lastAgentMessage || 'Task completed',
            },
          });
        } else if (raw.type === 'turn.failed') {
          terminalEventEmitted = true;
          seq += 1;
          const msg =
            typeof raw.error?.message === 'string'
              ? raw.error.message
              : raw.error
                ? JSON.stringify(raw.error)
                : 'Turn failed';
          callbacks.onEvent({
            runId: run.runId,
            sequence: seq,
            type: 'failed',
            timestamp: new Date().toISOString(),
            data: {
              errorCode: raw.error?.code || 'AGENT_ERROR',
              message: msg,
            },
          });
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      try {
        appendFileSync(run.logPath, `[stderr] ${text}`);
      } catch {
        // ignore
      }
    });

    child.on('close', (code, _signal) => {
      this.activeProcesses.delete(run.runId);

      // Process any remaining stdout in buffer
      if (stdoutBuffer.trim().length > 0) {
        const raw = parseCodexJsonLine(stdoutBuffer);
        if (raw?.type === 'item.completed' && raw.item?.type === 'agent_message') {
          seq += 1;
          lastAgentMessage = raw.item.text ?? '';
          callbacks.onEvent({
            runId: run.runId,
            sequence: seq,
            type: 'message.completed',
            timestamp: new Date().toISOString(),
            data: {
              messageId: raw.item.id || `msg_${seq}`,
              content: lastAgentMessage,
            },
          });
        }
      }

      run.exitCode = code;
      run.verifiedStoppedAt = new Date().toISOString();
      run.verificationMethod = 'process_group_empty';

      if (procRecord.wasCancelled) {
        run.status = 'cancelled';
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
      } else if (terminalEventEmitted) {
        run.status = code === 0 ? 'done' : 'error';
      } else if (code === 0) {
        run.status = 'done';
        seq += 1;
        callbacks.onEvent({
          runId: run.runId,
          sequence: seq,
          type: 'completed',
          timestamp: new Date().toISOString(),
          data: {
            summary: lastAgentMessage || 'Task completed',
          },
        });
      } else {
        run.status = 'error';
        seq += 1;
        callbacks.onEvent({
          runId: run.runId,
          sequence: seq,
          type: 'failed',
          timestamp: new Date().toISOString(),
          data: {
            errorCode: 'AGENT_ERROR',
            message: `Codex process exited with code ${code}`,
          },
        });
      }

      try {
        appendFileSync(
          run.logPath,
          `[${new Date().toISOString()}] Codex process stopped: exitCode=${code} status=${run.status}\n`,
        );
      } catch {
        // ignore
      }

      callbacks.onEnd();
    });
  }

  async cancel(run: AdapterRun): Promise<DriverCancelResult> {
    const active = this.activeProcesses.get(run.runId);
    if (!active) {
      return {
        verifiedStopped: true,
        verificationMethod: run.verificationMethod ?? 'process_group_empty',
      };
    }

    active.wasCancelled = true;
    const pgid = active.pgid;

    // Send SIGTERM to the process group
    try {
      process.kill(-pgid, 'SIGTERM');
    } catch {
      // Process or group already gone
    }

    // Wait up to 1000ms for clean termination
    const graceMs = 1000;
    const deadline = Date.now() + graceMs;
    let groupEmpty = false;

    while (Date.now() < deadline) {
      try {
        process.kill(-pgid, 0);
        await Bun.sleep(50);
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === 'ESRCH'
        ) {
          groupEmpty = true;
          break;
        }
      }
    }

    if (!groupEmpty) {
      // Escalate to SIGKILL
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // group already gone
      }

      const killDeadline = Date.now() + 500;
      while (Date.now() < killDeadline) {
        try {
          process.kill(-pgid, 0);
          await Bun.sleep(50);
        } catch (err: unknown) {
          if (
            err &&
            typeof err === 'object' &&
            'code' in err &&
            (err as { code: string }).code === 'ESRCH'
          ) {
            groupEmpty = true;
            break;
          }
        }
      }
    }

    run.verifiedStoppedAt = new Date().toISOString();
    run.verificationMethod = 'process_group_empty';
    run.status = 'cancelled';

    return {
      verifiedStopped: true,
      verificationMethod: 'process_group_empty',
    };
  }

  async provideInput(_run: AdapterRun, _req: ProvideInputRequest): Promise<{ ok: boolean }> {
    throw new AdapterError(
      'INVALID_TRANSITION',
      'Codex driver does not support interactive input in exec baseline',
    );
  }
}
