// Bounded and redacted run logger for agent adapter (SPECIFICATION.md §2; ARCHITECTURE.md §6, §12; CONSTITUTION.md §VII).
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';

export const DEFAULT_MAX_LOG_SIZE_BYTES = 1024 * 1024; // 1MB default log rotation threshold

const SENSITIVE_KEY_PATTERN =
  /(authorization|token|mcp_?token|access_?token|api_?key|password|secret|bearer|private_?key)/i;
const SENSITIVE_STRING_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: 'Bearer [REDACTED]' },
  { pattern: /sk-[A-Za-z0-9_-]{10,}/g, replacement: 'sk-[REDACTED]' },
  {
    pattern: /((?:token|secret|password|api_?key|mcp_?token)=)[^\s&]+/gi,
    replacement: '$1[REDACTED]',
  },
  {
    pattern: /"([a-zA-Z0-9_-]*(?:token|secret|password|key|auth)[a-zA-Z0-9_-]*)"\s*:\s*"[^"]+"/gi,
    replacement: '"$1":"[REDACTED]"',
  },
];

/**
 * Deeply redact sensitive strings, tokens, and authorization credentials from logs.
 */
export function redactSensitive(val: unknown, depth = 0): unknown {
  if (depth > 10) return '[MAX_DEPTH]';
  if (val === null || val === undefined) return val;

  if (typeof val === 'string') {
    let result = val;
    for (const { pattern, replacement } of SENSITIVE_STRING_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    // Bound single string log output to prevent log flood
    if (result.length > 2000) {
      return `${result.slice(0, 2000)}... [truncated ${result.length - 2000} chars]`;
    }
    return result;
  }

  if (typeof val === 'number' || typeof val === 'boolean') {
    return val;
  }

  if (Array.isArray(val)) {
    return val.map((item) => redactSensitive(item, depth + 1));
  }

  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(val as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactSensitive(prop, depth + 1);
      }
    }
    return out;
  }

  return String(val);
}

/**
 * Formats a single structured log line with timestamp, runId, sequence, and redacted payload.
 */
export function formatRunLogLine(params: {
  timestamp?: string;
  runId: string;
  sequence?: number;
  type: string;
  data?: unknown;
}): string {
  const ts = params.timestamp ?? new Date().toISOString();
  const seqStr = params.sequence !== undefined ? ` [seq ${params.sequence}]` : '';
  const dataStr =
    params.data !== undefined ? `: ${JSON.stringify(redactSensitive(params.data))}` : '';
  return `[${ts}] [run ${params.runId}]${seqStr} ${params.type}${dataStr}\n`;
}

/**
 * Appends a log line to a run log file, enforcing rotation when file size exceeds maxSizeBytes.
 */
export function writeRunLog(
  logPath: string,
  line: string,
  maxSizeBytes: number = DEFAULT_MAX_LOG_SIZE_BYTES,
): void {
  try {
    if (existsSync(logPath)) {
      const stats = statSync(logPath);
      if (stats.size >= maxSizeBytes) {
        // Rotate current log file to .1 (single backup)
        const backupPath = `${logPath}.1`;
        try {
          if (existsSync(backupPath)) {
            unlinkSync(backupPath);
          }
          renameSync(logPath, backupPath);
        } catch {
          // If rename fails, ignore and proceed
        }
        appendFileSync(
          logPath,
          `[${new Date().toISOString()}] [LOG_ROTATED] Previous log exceeded ${maxSizeBytes} bytes and was rotated to .1\n`,
        );
      }
    }

    appendFileSync(logPath, line);
  } catch {
    // Non-fatal if writing log fails
  }
}
