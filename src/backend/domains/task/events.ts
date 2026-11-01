// Event ingestion domain (SPECIFICATION.md §3, §7, ARCHITECTURE.md §6; T13, LC-04d).
import type { Database } from 'bun:sqlite';
import type { IngestEventsRequest } from '../../../contracts/event.ts';
import { ingestEventsUsecase } from '../../usecases/ingest-events-usecase.ts';

export function ingestEvents(
  db: Database,
  runId: string,
  request: IngestEventsRequest,
): { ok: true } {
  return ingestEventsUsecase(db, runId, request);
}
