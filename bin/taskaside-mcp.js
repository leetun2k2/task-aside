#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const dataDir =
  process.env.TASKASIDE_DATA_DIR ||
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'TaskAside')
    : join(homedir(), '.local', 'share', 'taskaside'));

const supervisorLock = join(dataDir, 'supervisor.json');
const tokenFile = join(dataDir, 'mcp_agy.token');

function getBackendInfo() {
  if (!existsSync(supervisorLock)) return null;
  try {
    const data = JSON.parse(readFileSync(supervisorLock, 'utf8'));
    const port = data.services?.backend?.port;
    if (!port) return null;
    let token = process.env.TASKASIDE_MCP_TOKEN;
    if (!token && existsSync(tokenFile)) {
      token = readFileSync(tokenFile, 'utf8').trim();
    }
    return { port, token };
  } catch {
    return null;
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  const info = getBackendInfo();
  if (!info || !info.port) {
    let id = null;
    try {
      id = JSON.parse(trimmed).id;
    } catch {}
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'TaskAside backend is not running. Please start it with `taskaside start`.',
        },
      }) + '\n',
    );
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (info.token) {
      headers.Authorization = `Bearer ${info.token}`;
    }

    const res = await fetch(`http://127.0.0.1:${info.port}/mcp`, {
      method: 'POST',
      headers,
      body: trimmed,
    });

    const responseBody = await res.text();
    process.stdout.write(responseBody + '\n');
  } catch (err) {
    let id = null;
    try {
      id = JSON.parse(trimmed).id;
    } catch {}
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `Failed to connect to TaskAside backend: ${String(err)}`,
        },
      }) + '\n',
    );
  }
});
