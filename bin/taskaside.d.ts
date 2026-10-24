export function resolveAppDataDir(): string;
export function commandAvailable(cmd: string, args: string[]): boolean;
export function resolveBunPath(): string | null;
export function installPayload(appDataDir: string): string;
