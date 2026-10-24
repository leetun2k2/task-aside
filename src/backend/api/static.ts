// Static frontend asset serving and security boundary (ARCHITECTURE.md §2.4, SPECIFICATION.md §6, TASKS.md T15).
// Serves Vite build output from `dist/frontend`. Strictly forbids directory traversal,
// access to arbitrary filesystem paths, database files (.db, .db-wal), or logs.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { Context, Hono } from 'hono';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// Forbidden extensions that must NEVER be served
const FORBIDDEN_EXTENSIONS = new Set([
  '.db',
  '.db-wal',
  '.db-shm',
  '.sqlite',
  '.log',
  '.env',
  '.ts',
  '.tsx',
  '.map',
  '.lock',
]);

export function getFrontendDir(overrideDir?: string): string {
  if (overrideDir) return resolve(overrideDir);
  if (process.env.TASKASIDE_FRONTEND_DIR) {
    return resolve(process.env.TASKASIDE_FRONTEND_DIR);
  }
  if (process.env.TASKASIDE_PAYLOAD_DIR) {
    const fromPayload = resolve(process.env.TASKASIDE_PAYLOAD_DIR, 'dist', 'frontend');
    if (existsSync(fromPayload)) return fromPayload;
  }
  const fromServices = resolve(import.meta.dir, '../frontend');
  if (existsSync(fromServices)) return fromServices;

  const fromSource = resolve(import.meta.dir, '../../../dist/frontend');
  if (existsSync(fromSource)) return fromSource;

  const fromCwd = resolve(process.cwd(), 'dist', 'frontend');
  if (existsSync(fromCwd)) return fromCwd;

  return fromServices;
}

export function mountStaticRoutes(app: Hono, options: { staticDir?: string } = {}): void {
  const frontendDir = getFrontendDir(options.staticDir);

  app.get('*', async (c: Context, next) => {
    const url = new URL(c.req.url);
    const pathname = decodeURIComponent(url.pathname);

    // Skip API, MCP, internal, and health routes - allow route handlers to run
    if (
      pathname.startsWith('/api/') ||
      pathname.startsWith('/internal/') ||
      pathname === '/mcp' ||
      pathname.startsWith('/mcp/') ||
      pathname === '/health'
    ) {
      return await next();
    }

    // Security check 1: Path traversal protection
    const rawUrl = c.req.url;
    if (
      pathname.includes('..') ||
      pathname.includes('\0') ||
      rawUrl.includes('..') ||
      rawUrl.includes('%2e%2e') ||
      rawUrl.includes('%2E%2E')
    ) {
      return c.text('Forbidden', 403);
    }

    // Security check 2: Forbidden extension check
    const reqExt = extname(pathname).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(reqExt)) {
      return c.text('Forbidden', 403);
    }

    const safeRelativePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    const candidatePath = join(
      frontendDir,
      safeRelativePath === '/' ? 'index.html' : safeRelativePath,
    );

    // Security check 3: Must resolve strictly within frontendDir
    const resolvedPath = resolve(candidatePath);
    if (!resolvedPath.startsWith(frontendDir)) {
      return c.text('Forbidden', 403);
    }

    // If candidate file exists and is a regular file, serve it
    if (existsSync(resolvedPath)) {
      try {
        const stat = statSync(resolvedPath);
        if (stat.isFile()) {
          const ext = extname(resolvedPath).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
          const content = readFileSync(resolvedPath);
          return new Response(content, {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(stat.size),
              'X-Content-Type-Options': 'nosniff',
            },
          });
        }
      } catch {
        return c.text('Internal Server Error', 500);
      }
    }

    // SPA fallback: for paths without asset extensions, serve index.html
    if (!reqExt || reqExt === '.html') {
      const indexPath = join(frontendDir, 'index.html');
      if (existsSync(indexPath)) {
        try {
          const content = readFileSync(indexPath);
          return new Response(content, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        } catch {
          return c.text('Internal Server Error', 500);
        }
      }
    }

    return c.text('Not Found', 404);
  });
}
