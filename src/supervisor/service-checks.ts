// Automated service-shell verification suite (T08). Run: bun run src/supervisor/service-checks.ts
// Exercises the supervisor against a disposable TASKASIDE_DATA_DIR: token
// provisioning, readiness-ordered startup, Host/Origin hardening, internal
// route auth, status/stop lifecycle and the single-instance lock.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAuthTokenPath, getInternalTokenPath } from './paths.ts';
import {
  type ServiceHandle,
  startServices,
  statusServices,
  stopServices,
} from './process-manager.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'taskaside-service-checks-'));
process.env.TASKASIDE_DATA_DIR = dataDir;

type CheckResult = { name: string; passed: boolean; error?: string };
const results: CheckResult[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

interface RawResponse {
  status: number;
  body: string;
}

// Raw TCP request so tests can send a forged `Host` header — the Fetch API
// forbids overriding `Host` and `Origin` outright.
function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? 'GET';
    const path = options.path ?? '/health';
    const headers = { Connection: 'close', ...options.headers };
    const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
    const request = [`${method} ${path} HTTP/1.1`, ...headerLines, '', ''].join('\r\n');

    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(request);
    });

    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    socket.on('end', () => {
      const headerEnd = raw.indexOf('\r\n\r\n');
      const head = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
      const statusLine = head.split('\r\n')[0] ?? '';
      const status = Number(statusLine.split(' ')[1]);
      const body = headerEnd === -1 ? '' : raw.slice(headerEnd + 4);
      resolve({ status, body });
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => {
      socket.destroy(new Error(`raw request to 127.0.0.1:${port}${path} timed out`));
    });
  });
}

function filePermissions(path: string): number {
  return statSync(path).mode & 0o777;
}

async function main(): Promise<void> {
  let handles: ServiceHandle[] = [];

  try {
    // --- Startup, readiness order, tokens -----------------------------------
    await checkAsync('startup: services start in readiness order', async () => {
      handles = await startServices();
      assert(handles.length === 3, `expected 3 service handles, got ${handles.length}`);
      assert(
        handles.map((h) => h.name).join(',') === 'backend,agent-adapter,execution-engine',
        'expected readiness order backend -> agent-adapter -> execution-engine',
      );
      for (const handle of handles) {
        assert(handle.status === 'running', `expected ${handle.name} to be running`);
        assert(handle.port > 0, `expected ${handle.name} to have a port`);
      }
    });

    check('tokens: auth.token exists with 0600 permissions', () => {
      assert(filePermissions(getAuthTokenPath()) === 0o600, 'expected auth.token mode 0600');
    });

    check('tokens: internal.token exists with 0600 permissions', () => {
      assert(
        filePermissions(getInternalTokenPath()) === 0o600,
        'expected internal.token mode 0600',
      );
    });

    const internalToken = readFileSync(getInternalTokenPath(), 'utf8').trim();
    const browserToken = readFileSync(getAuthTokenPath(), 'utf8').trim();

    const backend = handles.find((h) => h.name === 'backend');
    const adapter = handles.find((h) => h.name === 'agent-adapter');
    const engine = handles.find((h) => h.name === 'execution-engine');
    if (!backend || !adapter || !engine) {
      throw new Error('expected all three service handles to be present');
    }

    // --- Health endpoints -----------------------------------------------------
    for (const handle of [backend, adapter, engine]) {
      await checkAsync(`health: ${handle.name} reports ok/service/version`, async () => {
        const res = await rawRequest(handle.port, {
          headers: { Host: `127.0.0.1:${handle.port}` },
        });
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const body = JSON.parse(res.body) as { status: string; service: string; version: string };
        assert(body.status === 'ok', 'expected status ok');
        assert(
          body.service === handle.name,
          `expected service ${handle.name}, got ${body.service}`,
        );
        assert(
          typeof body.version === 'string' && body.version.length > 0,
          'expected version string',
        );
      });
    }

    // --- Host/Origin hardening -------------------------------------------------
    await checkAsync('host/origin: malicious Host header rejected with 403', async () => {
      const res = await rawRequest(backend.port, { headers: { Host: 'evil.com' } });
      assert(res.status === 403, `expected 403, got ${res.status}`);
    });

    await checkAsync('host/origin: malicious Origin header rejected with 403', async () => {
      const res = await rawRequest(backend.port, {
        headers: { Host: `127.0.0.1:${backend.port}`, Origin: 'http://attacker.com' },
      });
      assert(res.status === 403, `expected 403, got ${res.status}`);
    });

    await checkAsync('host/origin: valid Host and no Origin is accepted', async () => {
      const res = await rawRequest(backend.port, {
        headers: { Host: `127.0.0.1:${backend.port}` },
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
    });

    // --- /internal/v1/* auth ----------------------------------------------------
    const internalHeaders = (overrides: Record<string, string>) => ({
      Host: `127.0.0.1:${backend.port}`,
      ...overrides,
    });

    await checkAsync('internal auth: no auth header -> 401', async () => {
      const res = await rawRequest(backend.port, {
        path: '/internal/v1/ping',
        headers: internalHeaders({ 'X-TaskAside-Role': 'engine' }),
      });
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    await checkAsync('internal auth: wrong token -> 401', async () => {
      const res = await rawRequest(backend.port, {
        path: '/internal/v1/ping',
        headers: internalHeaders({
          Authorization: 'Bearer wrong-token',
          'X-TaskAside-Role': 'engine',
        }),
      });
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    await checkAsync('internal auth: browser token rejected -> 401', async () => {
      const res = await rawRequest(backend.port, {
        path: '/internal/v1/ping',
        headers: internalHeaders({
          Authorization: `Bearer ${browserToken}`,
          'X-TaskAside-Role': 'engine',
        }),
      });
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    await checkAsync('internal auth: missing role header -> 403', async () => {
      const res = await rawRequest(backend.port, {
        path: '/internal/v1/ping',
        headers: internalHeaders({ Authorization: `Bearer ${internalToken}` }),
      });
      assert(res.status === 403, `expected 403, got ${res.status}`);
    });

    await checkAsync('internal auth: invalid role header -> 403', async () => {
      const res = await rawRequest(backend.port, {
        path: '/internal/v1/ping',
        headers: internalHeaders({
          Authorization: `Bearer ${internalToken}`,
          'X-TaskAside-Role': 'browser',
        }),
      });
      assert(res.status === 403, `expected 403, got ${res.status}`);
    });

    await checkAsync('internal auth: valid token + valid role -> 200 (backend)', async () => {
      const res = await rawRequest(backend.port, {
        path: '/internal/v1/ping',
        headers: internalHeaders({
          Authorization: `Bearer ${internalToken}`,
          'X-TaskAside-Role': 'engine',
        }),
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
    });

    await checkAsync('internal auth: valid token + valid role -> 200 (adapter)', async () => {
      const res = await rawRequest(adapter.port, {
        path: '/internal/v1/ping',
        headers: {
          Host: `127.0.0.1:${adapter.port}`,
          Authorization: `Bearer ${internalToken}`,
          'X-TaskAside-Role': 'engine',
        },
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
    });

    // --- Status ------------------------------------------------------------
    await checkAsync('status: reports all three services running', async () => {
      const status = await statusServices();
      assert(status.length === 3, `expected 3 status entries, got ${status.length}`);
      for (const entry of status) {
        assert(entry.status === 'running', `expected ${entry.name} running, got ${entry.status}`);
      }
    });

    // --- Single-instance lock ------------------------------------------------
    await checkAsync('single-instance: duplicate start is rejected', async () => {
      let threw = false;
      try {
        await startServices();
      } catch {
        threw = true;
      }
      assert(threw, 'expected a second startServices() call to throw while already running');
    });
  } finally {
    // --- Stop ------------------------------------------------------------
    await checkAsync('stop: cleanly shuts down all three services', async () => {
      await stopServices();
      const status = await statusServices();
      for (const entry of status) {
        assert(entry.status === 'stopped', `expected ${entry.name} stopped, got ${entry.status}`);
      }
    });

    rmSync(dataDir, { recursive: true, force: true });
  }

  for (const result of results) {
    const marker = result.passed ? 'PASS' : 'FAIL';
    console.log(`[${marker}] ${result.name}${result.error ? ` — ${result.error}` : ''}`);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
