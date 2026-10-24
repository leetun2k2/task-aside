import { existsSync, readFileSync } from 'node:fs';
import { openBrowser } from '../supervisor/browser.ts';
import { getAuthTokenPath } from '../supervisor/paths.ts';
import {
  type ServiceHandle,
  startServices,
  statusServices,
  stopServices,
} from '../supervisor/process-manager.ts';
import { TASKASIDE_VERSION as VERSION } from '../supervisor/version.ts';

const HELP_TEXT = `taskaside ${VERSION}

Usage:
  taskaside <command> [options]

Commands:
  start     Start or attach to the local TaskAside supervisor (default)
  status    Report supervisor and service health
  stop      Stop the local TaskAside supervisor

Options:
  --help     Show this help message
  --version  Show the installed version
`;

type Command = 'start' | 'status' | 'stop';

function isCommand(value: string | undefined): value is Command {
  return value === 'start' || value === 'status' || value === 'stop';
}

function getLocalUrl(port: number): string {
  const tokenPath = getAuthTokenPath();
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
  return token ? `http://127.0.0.1:${port}/?token=${token}` : `http://127.0.0.1:${port}`;
}

async function runCommand(command: Command): Promise<void> {
  if (command === 'start') {
    let handles: ServiceHandle[];
    try {
      handles = await startServices();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already running')) {
        handles = await statusServices();
        const backend = handles.find((h) => h.name === 'backend');
        console.log(
          `already running: backend pid ${backend?.pid ?? 'unknown'}, port ${backend?.port ?? 'unknown'}`,
        );
        if (backend && backend.port > 0) {
          const url = getLocalUrl(backend.port);
          console.log(`local URL: ${url}`);
          openBrowser(url);
        }
        return;
      }
      throw err;
    }

    for (const handle of handles) {
      console.log(`${handle.name}: ${handle.status} (pid ${handle.pid}, port ${handle.port})`);
    }
    const backend = handles.find((h) => h.name === 'backend');
    if (backend && backend.port > 0) {
      const url = getLocalUrl(backend.port);
      console.log(`local URL: ${url}`);
      openBrowser(url);
    }
    return;
  }

  if (command === 'status') {
    const handles = await statusServices();
    for (const handle of handles) {
      console.log(`${handle.name}: ${handle.status} (pid ${handle.pid}, port ${handle.port})`);
    }
    return;
  }

  await stopServices();
  console.log('taskaside stopped');
}

async function run(argv: string[]): Promise<void> {
  const [first] = argv;

  if (first === '--help' || first === undefined) {
    console.log(HELP_TEXT);
    return;
  }

  if (first === '--version') {
    console.log(VERSION);
    return;
  }

  if (isCommand(first)) {
    await runCommand(first);
    return;
  }

  console.error(`Unknown command: ${first}\n`);
  console.log(HELP_TEXT);
  process.exit(1);
}

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
