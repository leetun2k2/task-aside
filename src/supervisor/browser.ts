import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  if (process.env.TASKASIDE_NO_BROWSER || process.env.CI || process.env.NODE_ENV === 'test') {
    return;
  }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Ignore browser launch failure
  }
}
