// Host/Origin hardening (ARCHITECTURE.md §3.1, SPECIFICATION.md §8.1).
// Loopback binding alone does not stop DNS rebinding or malicious-page requests,
// so every listener rejects any request whose Host/Origin does not name its own
// port under 127.0.0.1 or localhost.
import type { Context, Next } from 'hono';

export function hostOriginGuard(port: number) {
  const validHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const validOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  return async (c: Context, next: Next) => {
    const host = c.req.header('Host');
    if (!host || !validHosts.has(host)) {
      return c.json({ code: 'FORBIDDEN', message: 'invalid or missing Host header' }, 403);
    }

    const origin = c.req.header('Origin');
    if (origin !== undefined && !validOrigins.has(origin)) {
      return c.json({ code: 'FORBIDDEN', message: 'invalid Origin header' }, 403);
    }

    await next();
  };
}
