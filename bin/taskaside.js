#!/usr/bin/env node
// TaskAside Node-compatible launcher (ARCHITECTURE.md §10, SPECIFICATION.md §8).
// Resolves Bun runtime, copies a stable versioned payload to app-data directory,
// and routes CLI commands (start, status, stop).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

export function resolveAppDataDir() {
  if (process.env.TASKASIDE_DATA_DIR) {
    return path.resolve(process.env.TASKASIDE_DATA_DIR);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TaskAside');
  }
  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'TaskAside');
  }
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, 'taskaside');
}

export function commandAvailable(cmd, args) {
  try {
    const result = spawnSync(cmd, args, { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function resolveBunPath() {
  if (process.env.TASKASIDE_BUN_PATH && fs.existsSync(process.env.TASKASIDE_BUN_PATH)) {
    return process.env.TASKASIDE_BUN_PATH;
  }
  if (commandAvailable('bun', ['--version'])) {
    return 'bun';
  }
  const wellKnown = [
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'bun'),
  ];
  for (const candidate of wellKnown) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function installPayload(appDataDir) {
  const pkgJsonPath = path.join(PACKAGE_ROOT, 'package.json');
  let sourceVersion = '0.0.0';
  try {
    sourceVersion = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
  } catch {
    // fallback
  }

  const payloadDir = path.join(appDataDir, 'payload');
  const payloadManifest = path.join(payloadDir, 'package.json');
  const distDir = path.join(payloadDir, 'dist');

  let installedVersion = null;
  if (fs.existsSync(payloadManifest)) {
    try {
      installedVersion = JSON.parse(fs.readFileSync(payloadManifest, 'utf8')).version;
    } catch {
      installedVersion = null;
    }
  }

  // If payload exists and version matches and dist exists, reuse installed payload
  if (installedVersion === sourceVersion && fs.existsSync(distDir)) {
    return payloadDir;
  }

  fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.mkdirSync(payloadDir, { recursive: true });

  // Copy package.json
  if (fs.existsSync(pkgJsonPath)) {
    fs.cpSync(pkgJsonPath, payloadManifest);
  }

  // Copy dist (services and frontend)
  const sourceDist = path.join(PACKAGE_ROOT, 'dist');
  if (fs.existsSync(sourceDist)) {
    fs.cpSync(sourceDist, distDir, { recursive: true });
  } else {
    // Fallback in development if dist not built yet: copy src
    const sourceSrc = path.join(PACKAGE_ROOT, 'src');
    if (fs.existsSync(sourceSrc)) {
      fs.cpSync(sourceSrc, path.join(payloadDir, 'src'), { recursive: true });
    }
  }

  // Copy README.md if present
  const readmePath = path.join(PACKAGE_ROOT, 'README.md');
  if (fs.existsSync(readmePath)) {
    fs.cpSync(readmePath, path.join(payloadDir, 'README.md'));
  }

  return payloadDir;
}

function resolveCliEntrypoint(payloadDir) {
  const candidates = [
    path.join(payloadDir, 'dist', 'services', 'cli.js'),
    path.join(payloadDir, 'src', 'cmd', 'cli.ts'),
    path.join(PACKAGE_ROOT, 'dist', 'services', 'cli.js'),
    path.join(PACKAGE_ROOT, 'src', 'cmd', 'cli.ts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`could not resolve CLI entrypoint in payload (${payloadDir}) or package (${PACKAGE_ROOT})`);
}

function main() {
  const argv = process.argv.slice(2);
  const firstArg = argv[0];

  if (firstArg === '--help' || firstArg === '-h') {
    console.log(`TaskAside launcher

Usage:
  taskaside [command] [options]

Commands:
  start     Start or attach to the local TaskAside supervisor (default)
  status    Report supervisor and service health
  stop      Stop the local TaskAside supervisor

Options:
  --help, -h     Show this help message
  --version, -v  Show the installed version
`);
    process.exit(0);
  }

  if (firstArg === '--version' || firstArg === '-v') {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
      console.log(pkg.version);
    } catch {
      console.log('0.1.0');
    }
    process.exit(0);
  }

  const bunPath = resolveBunPath();
  if (!bunPath) {
    console.error(
      'TaskAside requires the Bun runtime (https://bun.sh) to execute services.\n' +
        'Please ensure `bun` is available on PATH or set TASKASIDE_BUN_PATH.',
    );
    process.exit(1);
  }

  const appDataDir = resolveAppDataDir();
  fs.mkdirSync(appDataDir, { recursive: true });

  const payloadDir = installPayload(appDataDir);
  const cliEntrypoint = resolveCliEntrypoint(payloadDir);

  const command = firstArg && !firstArg.startsWith('-') ? firstArg : 'start';
  const extraArgs = firstArg && !firstArg.startsWith('-') ? argv.slice(1) : argv;

  const result = spawnSync(bunPath, [cliEntrypoint, command, ...extraArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TASKASIDE_DATA_DIR: appDataDir,
      TASKASIDE_PAYLOAD_DIR: payloadDir,
      TASKASIDE_BUN_PATH: bunPath,
    },
  });

  process.exit(result.status ?? (result.error ? 1 : 0));
}

const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('taskaside.js') ||
    process.argv[1].endsWith('taskaside') ||
    path.resolve(process.argv[1]) === path.resolve(__filename));

if (isDirectExecution) {
  main();
}
