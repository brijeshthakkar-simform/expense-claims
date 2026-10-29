# ADR-0002: Layering and import boundaries are enforced by lint

- **Status:** Accepted (Phase 0, 2026-10-14; zones final in Phase 8)
- **Decision ids:** D-03, D-04 in [00-decisions-and-contracts](../design/00-decisions-and-contracts.md)
- **Detail:** [01 §7](../design/01-architecture-and-stack.md#7-layering-rules-and-how-lint-enforces-them)

## Context

The sharpest §6 test asks that a foreign claim is refused "at the point of the query". That is only true if there is no other way to load a claim: no route handler, page or service may reach Prisma and run an unscoped `findUnique`. A convention ("please go through the repository") decays the first time someone is in a hurry. We wanted the architecture to be a build failure.

## Decision

Requests flow route → service → repository → Prisma, and each zone below is a lint rule:

| Layer | Folder | May not import |
|---|---|---|
| Route handlers | `src/app/api/**/route.ts` | Prisma or `pg`, repositories, `next/headers` |
| Services | `src/server/services/**` | Prisma or `pg`, `next/*`, `src/server/http/*` |
| Repositories | `src/server/repositories/**` | `next/*`, `src/server/http/*`, services |
| DB helpers | `src/server/db/**` (client, `withTx`, SQLSTATE reader) | `next/*` |
| Pages and layouts | `src/app/**` outside `api/` | any `@/server/**` except `@/server/auth/rsc`; Prisma |
| Client and isomorphic code | `src/{shared,lib,components,features}/**` | any `@/server/**`; Prisma |

- `eslint.config.mjs` encodes each row as a `no-restricted-imports` zone (lines 75–85). Flat-config rule options do not merge, so every zone lists its full pattern set. The pages zone is a regex, because a gitignore-style negation can't re-include `@/server/auth/rsc`.
- `no-restricted-syntax` bans `'use server'`, `'use cache'`, `$queryRawUnsafe` and `$executeRawUnsafe` (lines 54–72).
- Every `src/server` file starts with `import 'server-only'`. Host scripts that import server code run with `tsx --conditions=react-server`.
- Signatures carry the actor: services are `(ctx: ServiceCtx, ...ids, input?)` with `ServiceCtx = { actor, requestId, clock? }`; repository writes are `(tx, actor, claimId, childId?)`. There is no unscoped `findClaimById` anywhere; the only by-id read is `findClaimForActor(actor, claimId, select)`.
- `src/shared/**` (strict Zod schemas, money, dates, enums, error codes) is isomorphic: the same schema validates the form and the request.

## Consequences

- Moving a query into a route handler, or importing Prisma into a component, fails `pnpm lint`, which `pnpm verify` and CI run.
- Services don't know about HTTP or Next, so the seed (`prisma/seed-claims.ts`), the perf scripts and the integration tests call them directly.
- Finance and export services self-guard with `requireRole` even though the route gate already ran (defence in depth for any future caller).
- Cost: some ceremony (DTO mappers, an explicit `ServiceCtx`), and lint rules that need a test of their own so they can't silently stop matching.

## Evidence

- TC-U10 (`tests/unit/lint-boundaries.test.ts`) › "importing @/generated/prisma from src/app fails lint", "importing @/server from src/components fails lint", "a 'use server' directive fails lint", "a 'use cache' directive fails lint". Each case lints a throwaway file in the real config.
- TC-U09 › "finance and export services throw FORBIDDEN for a non-finance actor before touching the database".
- TC-I17 › "approver requesting a claim outside their queue by id is refused at the point of the query" relies on this ADR: the captured SQL shows the one scoped SELECT.
- Files: `eslint.config.mjs`, `src/server/repositories/claim-visibility.ts`, `src/server/services/context.ts`.
