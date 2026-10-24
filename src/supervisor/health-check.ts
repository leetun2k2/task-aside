// Versioned readiness polling used by the supervisor to gate the start order
// backend -> agent-adapter -> execution-engine (ARCHITECTURE.md §2.5).
export interface HealthBody {
  status: 'ok';
  service: string;
  version: string;
  uptime: number;
}

function isHealthBody(value: unknown): value is HealthBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).status === 'ok' &&
    typeof (value as Record<string, unknown>).service === 'string' &&
    typeof (value as Record<string, unknown>).version === 'string'
  );
}

export async function checkHealthOnce(url: string): Promise<HealthBody | undefined> {
  const response = await fetch(url);
  if (!response.ok) {
    return undefined;
  }
  const body: unknown = await response.json();
  return isHealthBody(body) ? body : undefined;
}

export async function waitForHealth(
  url: string,
  timeoutMs: number,
  intervalMs = 100,
): Promise<HealthBody> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const body = await checkHealthOnce(url);
      if (body) {
        return body;
      }
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(intervalMs);
  }

  throw new Error(
    `service at ${url} did not report healthy within ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ''}`,
  );
}
