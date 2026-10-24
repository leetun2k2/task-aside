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

  const caps: CapabilitiesResponse = {
    providers: {
      codex: {
        available: Boolean(codexPath),
        resume: false, // Per SPECIFICATION.md §6: unverified until dedicated POC exercises exec resume
        mcp: false, // Per SPECIFICATION.md §6: until app-server POC
        version: codexVersion,
        notes: 'Codex exec baseline driver',
      },
      claude: {
        available: Boolean(claudePath),
        resume: true, // Per T02: verified cross-process via --session-id and --resume
        mcp: true, // Per T02: verified via --strict-mcp-config
        version: claudeVersion,
        notes: 'Claude Code CLI print-mode driver',
      },
    },
  };

  cachedCapabilities = CapabilitiesResponseSchema.parse(caps);
  return cachedCapabilities;
}

export function setAdapterCapabilitiesForTest(caps: CapabilitiesResponse | null): void {
  cachedCapabilities = caps;
}
