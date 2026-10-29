# ADR-0006: Authorization by scoped queries, and the 404-vs-403 policy

- **Status:** Accepted (Phases 2–6; final 2026-10-16)
- **Decision ids:** D-25, D-26, D-14, D-46 in [00-decisions-and-contracts](../design/00-decisions-and-contracts.md)
- **Detail:** [04 §4–§6](../design/04-security-and-api.md#4-authorization-model)

## Context

§6's sharpest check: an approver who requests a claim outside their queue by id must be "refused at the point of the query". §6 also wants clear, specific failures rather than generic ones. §3.5 says claimants see only their own claims, approvers see what is routed to them (decided ones optionally), and finance sees everything, read-only. Load-then-check in a service, or hiding things in the UI, would satisfy none of these against a direct API call, and a 403 for every invisible id would tell a prober which ids exist.

## Decision

**Reads.** One predicate, `claimVisibilityWhere(actor)` (`src/server/repositories/claim-visibility.ts`): the claimant, OR an approver with a PENDING, APPROVED or REJECTED step on the claim (any revision), OR FINANCE. `findClaimForActor()` AND-composes it into the single SELECT that loads the claim, and it is the only by-id read. History and receipts are reached only through that scoped claim. WAITING and CANCELLED-without-decision steps grant nothing. Decided approvers keep read-only access. Finance reads every claim including drafts; its list hides DRAFT unless asked.

**Writes.** Every mutation opens with an actor-scoped lock: `lockOwnedClaim` (`claimant_id = me … FOR NO KEY UPDATE`) for owner actions, `lockClaimRoutedToMe` (an EXISTS on my PENDING step) for decisions. Line and receipt ids in a request must belong to the path claim, which must be mine. Lists have route-fixed scopes (`claimant_id = me`, `approver_id = me`, FINANCE only).

**The failure ladder:** 401 → 403 → 404 → 409 → 422.

| Situation | Answer |
|---|---|
| Can't see or own the claim (or it doesn't exist) | 404 `CLAIM_NOT_FOUND`, byte-identical to a random UUID |
| Wrong persona for the route (role gate, before any query) | 403 `FORBIDDEN` |
| Approve or reject with no PENDING step of mine, for any id | 403 `NOT_IN_YOUR_QUEUE` (same body for a random id) |
| I decided the current revision already | 409 `ALREADY_DECIDED` |
| The claim's state forbids it | 409 `CLAIM_LOCKED`, `CLAIM_NOT_EDITABLE`, `INVALID_STATUS_TRANSITION`, `REVISION_MISMATCH` |

`allowedActions` in each claim response comes from the same `decide()` the services use; the UI renders buttons only from it, which is cosmetic by design.

**Row-Level Security: not planned.** The predicate already makes Postgres refuse the row; RLS would add a second authorization surface to keep in sync and force every read into an interactive transaction. It is the documented next hardening step.

## Consequences

- An out-of-scope row never leaves PostgreSQL, so there is nothing to filter, leak or log.
- Reads answer "if you can't see it, it doesn't exist"; commands against your queue answer with a specific 403; state conflicts get a specific 409. None of them is an existence oracle.
- The HTML page for a foreign claim is a 200 client shell with no data; the security-relevant response is the API's 404.
- Cost: every repository function takes an `actor`, and the visibility predicate must stay index-friendly (`approval_steps_visibility_idx`).

## Evidence

- TC-I17 (`tests/integration/authz/out-of-queue-by-id.int.test.ts`) › "approver requesting a claim outside their queue by id is refused at the point of the query", "GET /claims/:id returns 404 CLAIM_NOT_FOUND identical to the 404 for a random UUID", "history and receipt routes for that claim return 404", "approve and reject return 403 NOT_IN_YOUR_QUEUE", "nothing changes: step statuses, the claim row and claim_events are untouched".
- TC-I18 (`tests/integration/authz/visibility-matrix.int.test.ts`): the relationship × action × status matrix (fixtures F1 and F2) and "finance can GET any claim including drafts and every write returns 404 or 403 FORBIDDEN".
- TC-I14 (`tests/integration/authz/child-idor.int.test.ts`) › "PUT on my claim containing another claim's line id returns 404 LINE_ITEM_NOT_FOUND and changes nothing", "downloading or deleting another claim's receipt through my claim id returns 404 RECEIPT_NOT_FOUND".
- TC-I19 › "approving a non-existent id returns the same 403 NOT_IN_YOUR_QUEUE body", "FINANCE approve/reject returns 403 FORBIDDEN"; TC-U04 › "decide() is exhaustive over status × relationship × action"; TC-I25 › "never lists claims routed to other approvers or WAITING steps"; TC-E02 › "neha opening asha's claim sees the not-found view and the API returns 404".
