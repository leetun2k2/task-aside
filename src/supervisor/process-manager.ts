// Supervisor process manager (ARCHITECTURE.md §2.5): starts the three service
// CMDs in readiness order (backend -> agent-adapter -> execution-engine), each
// loopback-bound and detached into its own process group, waits for versioned
// health before advancing, and persists a single-instance lock file with PID,
// ports, status and version.
//
// Children are spawned detached (T04 evidence: `detached: true` makes PGID ==
// PID on POSIX) so `stopServices` can signal the whole process group rather
// than a bare PID, and escalate SIGTERM -> SIGKILL only after the group is
// confirmed non-empty.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAuthToken, ensureInternalToken } from './auth.ts';
import { checkHealthOnce, waitForHealth } from './health-check.ts';
import { ensureDataDirs, getDataDir, getLockFilePath, getLogFilePath } from './paths.ts';
import { resolvePort } from './ports.ts';
import { TASKASIDE_VERSION } from './version.ts';

export type ServiceName = 'backend' | 'agent-adapter' | 'execution-engine';

export type ServiceStatus = 'starting' | 'running' | 'uncertain' | 'stopped';

export interface ServiceHandle {
  name: ServiceName;
  pid: number;
  port: number;
  status: ServiceStatus;
}

interface SupervisorLock {
  pid: number;
  version: string;
  status: 'running';
  startedAt: string;
  services: Record<ServiceName, { pid: number; port: number }>;
}

export interface StartOptions {
  /** Repository root containing `src/cmd/*.ts`. Defaults to `process.cwd()`. */
  repoRoot?: string;
  /** Per-service health readiness timeout. Defaults to 10s. */
  healthTimeoutMs?: number;
}

const SERVICE_ORDER: readonly ServiceName[] = ['backend', 'agent-adapter', 'execution-engine'];

const SERVICE_ENTRYPOINT: Record<ServiceName, string> = {
  backend: join('src', 'cmd', 'backend.ts'),
  'agent-adapter': join('src', 'cmd', 'agent-adapter.ts'),
  'execution-engine': join('src', 'cmd', 'execution-engine.ts'),
};

const SERVICE_PORT_ENV: Record<ServiceName, string> = {
  backend: 'TASKASIDE_BACKEND_PORT',
  'agent-adapter': 'TASKASIDE_ADAPTER_PORT',
  'execution-engine': 'TASKASIDE_ENGINE_PORT',
};

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 2_000;

function readLock(): SupervisorLock | undefined {
  const path = getLockFilePath();
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SupervisorLock;
  } catch {
    return undefined;
  }
}

function writeLock(lock: SupervisorLock): void {
  writeFileSync(getLockFilePath(), JSON.stringify(lock, null, 2), { mode: 0o600 });
}

function removeLock(): void {
  const path = getLockFilePath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessGroup(pid: number, graceMs: number): Promise<void> {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await Bun.sleep(100);
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Group already empty.
  }
}

// Starts backend -> agent-adapter -> execution-engine in order, waiting for
// each to report healthy before spawning the next. Refuses to start a second
// instance while a prior one's backend process is still alive.
export async function startServices(options: StartOptions = {}): Promise<ServiceHandle[]> {
  ensureDataDirs();

  const existingLock = readLock();
  if (existingLock && isProcessAlive(existingLock.services.backend.pid)) {
    throw new Error(
      `taskaside is already running (backend pid ${existingLock.services.backend.pid}); run \`taskaside stop\` first`,
    );
  }
  if (existingLock) {
    removeLock();
  }

  ensureAuthToken();
  const internalToken = ensureInternalToken();

  const repoRoot = options.repoRoot ?? process.env.TASKASIDE_PAYLOAD_DIR ?? process.cwd();
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const dataDir = getDataDir();
  const bunExec = process.env.TASKASIDE_BUN_PATH || (typeof Bun !== 'undefined' ? process.execPath : 'bun');

  const handles: ServiceHandle[] = [];
  const serviceLocks = {} as SupervisorLock['services'];

  for (const name of SERVICE_ORDER) {
    const bundledEntry = join(repoRoot, 'dist', 'services', `${name}.js`);
    const sourceEntry = join(repoRoot, SERVICE_ENTRYPOINT[name]);
    const entrypoint = existsSync(bundledEntry) ? bundledEntry : sourceEntry;
    if (!existsSync(entrypoint)) {
      throw new Error(`cannot start ${name}: entrypoint not found at ${entrypoint}`);
    }

    const port = await resolvePort(process.env[SERVICE_PORT_ENV[name]]);
    const logFd = openSync(getLogFilePath(name), 'a');

    const child = spawn(bunExec, [entrypoint], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        [SERVICE_PORT_ENV[name]]: String(port),
        TASKASIDE_INTERNAL_TOKEN: internalToken,
        TASKASIDE_DATA_DIR: dataDir,
        TASKASIDE_PAYLOAD_DIR: repoRoot,
        TASKASIDE_BUN_PATH: bunExec,
        ...(serviceLocks.backend
          ? { TASKASIDE_BACKEND_PORT: String(serviceLocks.backend.port) }
          : {}),
        ...(serviceLocks['agent-adapter']
          ? { TASKASIDE_ADAPTER_PORT: String(serviceLocks['agent-adapter'].port) }
          : {}),
      },
    });
    closeSync(logFd);
    child.unref();

    if (!child.pid) {
      throw new Error(`failed to spawn ${name}`);
    }

    try {
      await waitForHealth(`http://127.0.0.1:${port}/health`, healthTimeoutMs);
    } catch (err) {
      await terminateProcessGroup(child.pid, STOP_GRACE_MS);
      throw new Error(
        `${name} failed readiness: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    handles.push({ name, pid: child.pid, port, status: 'running' });
    serviceLocks[name] = { pid: child.pid, port };
  }

  writeLock({
    pid: process.pid,
    version: TASKASIDE_VERSION,
    status: 'running',
    startedAt: new Date().toISOString(),
    services: serviceLocks,
  });

  return handles;
}

// Reports process liveness and health-endpoint status for each service, read
// from the on-disk lock so it works from a separate CLI invocation.
export async function statusServices(): Promise<ServiceHandle[]> {
  const lock = readLock();

  if (!lock) {
    return SERVICE_ORDER.map((name) => ({ name, pid: 0, port: 0, status: 'stopped' as const }));
  }

  const handles: ServiceHandle[] = [];
  for (const name of SERVICE_ORDER) {
    const entry = lock.services[name];
    if (!entry || !isProcessAlive(entry.pid)) {
      handles.push({ name, pid: entry?.pid ?? 0, port: entry?.port ?? 0, status: 'stopped' });
      continue;
    }

    const healthy = await checkHealthOnce(`http://127.0.0.1:${entry.port}/health`).catch(
      () => undefined,
    );
    handles.push({
      name,
      pid: entry.pid,
      port: entry.port,
      status: healthy ? 'running' : 'uncertain',
    });
  }

  return handles;
}

// Stops execution-engine -> agent-adapter -> backend (reverse readiness order),
// process-group SIGTERM escalating to SIGKILL, then clears the lock file.
export async function stopServices(): Promise<void> {
  const lock = readLock();
  if (!lock) {
    return;
  }

  for (const name of [...SERVICE_ORDER].reverse()) {
    const entry = lock.services[name];
    if (!entry) {
      continue;
    }
    await terminateProcessGroup(entry.pid, STOP_GRACE_MS);
  }

  removeLock();
}
