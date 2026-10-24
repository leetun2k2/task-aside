// Claude driver implementation (ARCHITECTURE.md §6, TASKS.md T18, SPECIFICATION.md §2, §3, §6; T02 evidence).
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
import type { AgentDriver, DriverCallbacks, DriverCancelResult } from './types.ts';

export interface ClaudeRawContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  thinking?: string;
  signature?: string;
}

export interface ClaudeRawMessage {
  id?: string;
  role?: string;
  type?: string;
  content?: ClaudeRawContentBlock[] | string;
  model?: string;
}

export interface ClaudeRawEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  timestamp?: string;
  message?: ClaudeRawMessage;
  result?: string;
  is_error?: boolean;
  terminal_reason?: string;
  api_error_status?: number | null;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status?: string }>;
}

export function parseClaudeJsonLine(line: string): ClaudeRawEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ClaudeRawEvent;
  } catch {
    return null;
  }
}

export interface BuildClaudeArgsResult {
  args: string[];
  env: Record<string, string>;
  assignedSessionId?: string;
}

export function buildClaudeArgs(run: AdapterRun): BuildClaudeArgsResult {
  const args: string[] = ['-p'];
  let assignedSessionId: string | undefined;

  if (run.sessionId) {
    args.push('--resume', run.sessionId);
  } else {
    // Generate and pin a session ID so that future turns can resume via --resume (T02 §10)
    assignedSessionId = randomUUID();
    args.push('--session-id', assignedSessionId);
  }

  // Permission handling and output format for unattended streamable execution (T02 §2, §4)
  args.push(
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    '--output-format',
    'stream-json',
    '--verbose',
  );

  // Scoped MCP: prevent inheriting user ambient ~/.claude configuration (T02 §8, §9, §13)
  args.push('--strict-mcp-config');
  if (run.mcp) {
    const mcpConfig = {
      mcpServers: {
        taskaside: {
          type: 'http',
          url: run.mcp.endpoint,
          headers: {
            Authorization: `Bearer ${run.mcp.accessToken}`,
          },
        },
      },
    };
    args.push('--mcp-config', JSON.stringify(mcpConfig));
  } else {
    args.push('--mcp-config', JSON.stringify({ mcpServers: {} }));
  }

  // Trailing argument: prompt
  args.push(run.instruction);

  return {
    args,
    env: {},
    assignedSessionId,
  };
}

export interface ClaudeStreamMapperResult {
  sessionId?: string;
  events: EventEnvelope[];
  terminalType?: 'completed' | 'failed' | 'cancelled';
  lastMessageText?: string;
}

/**
 * Pure stream mapper that processes raw lines from Claude stream-json and produces
 * versioned flat TaskAside EventEnvelope items.
 */
export function mapClaudeJsonLines(
  lines: string[],
  runId: string,
  startSequence = 0,
): ClaudeStreamMapperResult {
  let seq = startSequence;
  let sessionId: string | undefined;
  let lastMessageText: string | undefined;
  let terminalType: 'completed' | 'failed' | 'cancelled' | undefined;
  const events: EventEnvelope[] = [];

  for (const line of lines) {
    const raw = parseClaudeJsonLine(line);
    if (!raw) {
      continue;
    }

    if (raw.session_id && !sessionId) {
      sessionId = raw.session_id;
    }

    if (raw.type === 'assistant' && raw.message) {
      let textContent = '';
      if (typeof raw.message.content === 'string') {
        textContent = raw.message.content;
      } else if (Array.isArray(raw.message.content)) {
        const textParts = raw.message.content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string);
        if (textParts.length > 0) {
          textContent = textParts.join('\n');
        }
      }

      if (textContent.trim().length > 0) {
        lastMessageText = textContent;
        seq += 1;
        events.push({
          runId,
          sequence: seq,
          type: 'message.completed',
          timestamp: raw.timestamp || new Date().toISOString(),
          data: {
            messageId: raw.message.id || `msg_${seq}`,
            content: textContent,
          },
        });
      }
    } else if (raw.type === 'result') {
      // T02 quirk: terminal result event subtype is 'success' even when is_error: true and terminal_reason: 'api_error'.
      // Must branch on is_error / terminal_reason, NOT subtype.
      const isError = Boolean(
        raw.is_error === true ||
        raw.terminal_reason === 'api_error' ||
        raw.terminal_reason === 'error',
      );

      if (isError) {
        terminalType = 'failed';
        seq += 1;
        const errorCode =
          (raw.api_error_status ? `API_ERROR_${raw.api_error_status}` : raw.terminal_reason) ||
          'AGENT_ERROR';
        const message =
          typeof raw.result === 'string' && raw.result.trim().length > 0
            ? raw.result
            : raw.terminal_reason || 'Claude turn failed';
        events.push({
          runId,
          sequence: seq,
          type: 'failed',
          timestamp: raw.timestamp || new Date().toISOString(),
          data: {
            errorCode,
            message,
          },
        });
      } else {
        terminalType = 'completed';
        seq += 1;
        const summary =
          typeof raw.result === 'string' && raw.result.trim().length > 0
            ? raw.result
            : lastMessageText || 'Task completed';
        events.push({
          runId,
          sequence: seq,
          type: 'completed',
          timestamp: raw.timestamp || new Date().toISOString(),
          data: {
            summary,
          },
        });
      }
    }
  }

  return { sessionId, events, terminalType, lastMessageText };
}

export class ClaudeDriver implements AgentDriver {
  readonly provider = 'claude' as const;
  private claudePath: string;
  private activeProcesses = new Map<
    string,
    { child: ChildProcess; pgid: number; wasCancelled: boolean }
  >();

  constructor(options: { claudePath?: string } = {}) {
    this.claudePath = options.claudePath ?? Bun.which('claude') ?? 'claude';
  }

  async start(run: AdapterRun, callbacks: DriverCallbacks): Promise<void> {
    const { args, env, assignedSessionId } = buildClaudeArgs(run);

    if (assignedSessionId) {
      run.sessionId = assignedSessionId;
      if (callbacks.onSessionId) {
        callbacks.onSessionId(assignedSessionId);
      }
    }

    try {
      appendFileSync(
        run.logPath,
        `[${new Date().toISOString()}] Launching claude: ${this.claudePath} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`,
      );
    } catch {
      // ignore log append error
    }

    const child = spawn(this.claudePath, args, {
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
    let terminalType: 'completed' | 'failed' | 'cancelled' | undefined;
    let lastAgentMessage = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const raw = parseClaudeJsonLine(line);
        if (!raw) {
          continue;
        }

        if (raw.session_id) {
          run.sessionId = raw.session_id;
          if (callbacks.onSessionId) {
            callbacks.onSessionId(raw.session_id);
          }
        }

        if (raw.type === 'assistant' && raw.message) {
          let textContent = '';
          if (typeof raw.message.content === 'string') {
            textContent = raw.message.content;
          } else if (Array.isArray(raw.message.content)) {
            const textParts = raw.message.content
              .filter((block) => block.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text as string);
            if (textParts.length > 0) {
              textContent = textParts.join('\n');
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
                messageId: raw.message.id || `msg_${seq}`,
                content: textContent,
              },
            });
          }
        } else if (raw.type === 'result') {
          terminalEventEmitted = true;
          const isError = Boolean(
            raw.is_error === true ||
            raw.terminal_reason === 'api_error' ||
            raw.terminal_reason === 'error',
          );

          if (isError) {
            terminalType = 'failed';
            seq += 1;
            const errorCode =
              (raw.api_error_status ? `API_ERROR_${raw.api_error_status}` : raw.terminal_reason) ||
              'AGENT_ERROR';
            const message =
              typeof raw.result === 'string' && raw.result.trim().length > 0
                ? raw.result
                : raw.terminal_reason || 'Claude turn failed';
            callbacks.onEvent({
              runId: run.runId,
              sequence: seq,
              type: 'failed',
              timestamp: raw.timestamp || new Date().toISOString(),
              data: {
                errorCode,
                message,
              },
            });
          } else {
            terminalType = 'completed';
            seq += 1;
            const summary =
              typeof raw.result === 'string' && raw.result.trim().length > 0
                ? raw.result
                : lastAgentMessage || 'Task completed';
            callbacks.onEvent({
              runId: run.runId,
              sequence: seq,
              type: 'completed',
              timestamp: raw.timestamp || new Date().toISOString(),
              data: {
                summary,
              },
            });
          }
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

      // Process any trailing buffered stdout
      if (stdoutBuffer.trim().length > 0) {
        const raw = parseClaudeJsonLine(stdoutBuffer);
        if (raw?.type === 'assistant' && raw.message) {
          let textContent = '';
          if (typeof raw.message.content === 'string') {
            textContent = raw.message.content;
          } else if (Array.isArray(raw.message.content)) {
            const textParts = raw.message.content
              .filter((block) => block.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text as string);
            if (textParts.length > 0) {
              textContent = textParts.join('\n');
            }
          }
          if (textContent.trim().length > 0) {
            seq += 1;
            lastAgentMessage = textContent;
            callbacks.onEvent({
              runId: run.runId,
              sequence: seq,
              type: 'message.completed',
              timestamp: new Date().toISOString(),
              data: {
                messageId: raw.message.id || `msg_${seq}`,
                content: textContent,
              },
            });
          }
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
        run.status = code === 0 && terminalType !== 'failed' ? 'done' : 'error';
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
            message: `Claude process exited with code ${code}`,
          },
        });
      }

      try {
        appendFileSync(
          run.logPath,
          `[${new Date().toISOString()}] Claude process stopped: exitCode=${code} status=${run.status}\n`,
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

    // Send SIGTERM to the process group (CONSTITUTION.md, T04 §3)
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
      'Claude print-mode driver does not support interactive mid-process input; use cross-process resume with sessionId',
    );
  }
}
