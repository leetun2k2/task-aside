// Adapter capabilities discovery (SPECIFICATION.md §2, §3; ARCHITECTURE.md §6).
import { type CapabilitiesResponse, CapabilitiesResponseSchema } from '../contracts/index.ts';

let cachedCapabilities: CapabilitiesResponse | null = null;

export function probeAdapterCapabilities(forceFresh = false): CapabilitiesResponse {
  if (cachedCapabilities && !forceFresh) {
    return cachedCapabilities;
  }

  const codexPath = Bun.which('codex');
  let codexVersion: string | undefined;
  if (codexPath) {
    try {
      const res = Bun.spawnSync(['codex', '--version']);
      if (res.exitCode === 0) {
        codexVersion = res.stdout.toString().trim();
      }
    } catch {
      // Ignore version probe error
    }
  }

  const claudePath = Bun.which('claude');
  let claudeVersion: string | undefined;
  if (claudePath) {
    try {
      const res = Bun.spawnSync(['claude', '--version']);
      if (res.exitCode === 0) {
        claudeVersion = res.stdout.toString().trim();
      }
    } catch {
      // Ignore version probe error
    }
  }

  const agyPath = Bun.which('agy');
  let agyVersion: string | undefined;
  if (agyPath) {
    try {
      const res = Bun.spawnSync(['agy', '--version']);
      if (res.exitCode === 0) {
        agyVersion = res.stdout.toString().trim();
      }
    } catch {
      // Ignore version probe error
    }
  }

  const isDarwinArm64 = process.platform === 'darwin' && process.arch === 'arm64';

  const caps: CapabilitiesResponse = {
    providers: {
      codex: {
        available: Boolean(codexPath),
        resume: false, // Per SPECIFICATION.md §6: unverified until dedicated POC exercises exec resume
        mcp: false, // Per SPECIFICATION.md §6: until app-server POC
        multiRoot: Boolean(codexPath && isDarwinArm64),
        version: codexVersion,
        notes: 'Codex exec baseline driver',
      },
      claude: {
        available: Boolean(claudePath),
        resume: true, // Per T02: verified cross-process via --session-id and --resume
        mcp: true, // Per T02: verified via --strict-mcp-config
        multiRoot: Boolean(claudePath && isDarwinArm64),
        version: claudeVersion,
        notes: 'Claude Code CLI print-mode driver',
      },
      agy: {
        available: Boolean(agyPath),
        resume: true,
        mcp: true,
        multiRoot: false,
        version: agyVersion,
        notes: 'Antigravity CLI driver',
      },
    },
  };

  cachedCapabilities = CapabilitiesResponseSchema.parse(caps);
  return cachedCapabilities;
}

export function setAdapterCapabilitiesForTest(caps: CapabilitiesResponse | null): void {
  cachedCapabilities = caps;
}
