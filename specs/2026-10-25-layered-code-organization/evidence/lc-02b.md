# Evidence: LC-02b — Separate Git repository registration

## Outcome
Extracted Git repository registration and listing into layered responsibilities:
- Handlers: `src/backend/api/repositories.ts` handles REST input, validation, and delegates to usecases.
- Usecases:
  - `src/backend/domains/task/usecases/register-repository-usecase.ts`: Application action coordinating canonicalization, duplicate checks, and storage.
  - `src/backend/domains/task/usecases/list-repositories-usecase.ts`: Simple read bypasses empty service layer (`usecase -> repository`).
  - `src/backend/domains/task/usecases/get-repository-usecase.ts`: Simple read bypasses empty service layer (`usecase -> repository`).
- Services: `src/backend/domains/task/services/git-repository-service.ts`: Enforces duplicate canonical-path rules and prepares registration records.
- Repositories: `src/backend/domains/task/repositories/git-repository-repository.ts`: Direct SQLite SQL queries and row mappings (`insertRepository`, `findRepositories`, `findRepositoryByCanonicalPath`, `findRepositoryById`).
- Compatibility bridge: `src/backend/domains/task/repositories.ts` re-exports usecases for backward compatibility.

## Affected Owners / Files
- `src/backend/domains/task/repositories/git-repository-repository.ts` (new)
- `src/backend/domains/task/services/git-repository-service.ts` (new)
- `src/backend/domains/task/usecases/register-repository-usecase.ts` (new)
- `src/backend/domains/task/usecases/list-repositories-usecase.ts` (new)
- `src/backend/domains/task/usecases/get-repository-usecase.ts` (new)
- `src/backend/domains/task/repositories.ts` (updated)
- `src/backend/api/repositories.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-02b.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, no TS errors)
2. `bun run lint`: Passed (147 files checked, 0 errors)
3. `bun run test:db`: 13/13 passed (0 failed)
4. `bun run test:api`: 27/27 passed (0 failed)
5. `bun run test:contracts`: 32/32 passed (0 failed)

## Rollback
To roll back this slice:
- Revert `src/backend/api/repositories.ts` and `src/backend/domains/task/repositories.ts`.
- Remove `src/backend/domains/task/repositories/git-repository-repository.ts`, `src/backend/domains/task/services/git-repository-service.ts`, and `src/backend/domains/task/usecases/{register-repository-usecase,list-repositories-usecase,get-repository-usecase}.ts`.

## Next Task
LC-03a: Separate task and context reads.
