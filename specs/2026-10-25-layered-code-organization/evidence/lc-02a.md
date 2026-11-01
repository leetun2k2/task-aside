# Evidence: LC-02a — Pilot settings layers

## Outcome
Separated settings and diagnostics into clean handler, usecase, domain service, and repository layers:
- Handlers: `src/backend/api/settings.ts` validates HTTP requests, delegates to usecases, and maps JSON responses.
- Usecases:
  - `src/backend/domains/settings/usecases/get-settings-usecase.ts`: Simple read bypasses empty service layer (`usecase -> repository`).
  - `src/backend/domains/settings/usecases/update-settings-usecase.ts`: Orchestrates settings retrieval, rules application, and SQL update.
  - `src/backend/domains/settings/usecases/get-diagnostics-usecase.ts`: Simple read coordinating counts and path from repository.
- Services: `src/backend/domains/settings/services/settings-service.ts`: Houses domain update rules (`resolveSettingsUpdate`).
- Repositories: `src/backend/domains/settings/repositories/settings-repository.ts`: Owns direct SQLite access (`getSettingsRow`, `updateSettingsRow`, counts, and database path).
- Compatibility bridge: `src/backend/domains/settings/settings.ts` re-exports usecases for backward compatibility.

## Affected Owners / Files
- `src/backend/domains/settings/repositories/settings-repository.ts` (new)
- `src/backend/domains/settings/services/settings-service.ts` (new)
- `src/backend/domains/settings/usecases/get-settings-usecase.ts` (new)
- `src/backend/domains/settings/usecases/update-settings-usecase.ts` (new)
- `src/backend/domains/settings/usecases/get-diagnostics-usecase.ts` (new)
- `src/backend/domains/settings/settings.ts` (updated)
- `src/backend/api/settings.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-02a.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, no TS errors)
2. `bun run lint`: Passed (142 files checked, 0 errors)
3. `bun run test:db`: 13/13 passed (0 failed)
4. `bun run test:api`: 27/27 passed (0 failed)
5. `bun run test:projection`: 26/26 passed (0 failed)
6. `bun run test:contracts`: 32/32 passed (0 failed)

## Rollback
To roll back this slice:
- Revert changes to `src/backend/api/settings.ts` and `src/backend/domains/settings/settings.ts`.
- Remove `src/backend/domains/settings/repositories/settings-repository.ts`, `src/backend/domains/settings/services/settings-service.ts`, and `src/backend/domains/settings/usecases/`.

## Next Task
LC-02b: Separate Git repository registration.
