// Agent adapter entrypoint (ARCHITECTURE.md §2.3): owns Codex/Claude driver
// subprocesses, sessions and run events/logs. Does not select tasks or mutate task
// state.
import { createAdapterApp } from '../agent-adapter/index.ts';

const port = Number(process.env.TASKASIDE_ADAPTER_PORT ?? 0);
const app = createAdapterApp({ port });

export default {
  port,
  hostname: '127.0.0.1',
  fetch: app.fetch,
  idleTimeout: 0,
};
