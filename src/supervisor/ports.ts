// Port checking: dynamic allocation or explicit env override, validated free
// before use (ARCHITECTURE.md §8, §10).
import { createServer } from 'node:net';

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate a free loopback port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

// Resolves the port for a service: an explicit env override must be free,
// otherwise the OS assigns one.
export async function resolvePort(envValue: string | undefined): Promise<number> {
  if (envValue === undefined || envValue === '') {
    return getFreePort();
  }

  const parsed = Number(envValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid port override: ${envValue}`);
  }

  const free = await isPortFree(parsed);
  if (!free) {
    throw new Error(`port ${parsed} is already in use`);
  }
  return parsed;
}
