// Single source of truth for the version reported by health endpoints and the
// supervisor lock file. Kept separate from package.json to avoid a JSON import
// across every service entrypoint.
export const TASKASIDE_VERSION = '0.1.0';
