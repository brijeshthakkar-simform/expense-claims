# ADR-0005: Approval routing is data plus one pure function

- **Status:** Accepted (Phase 3, 2026-10-14; unchanged since)
- **Decision ids:** D-19, D-20, C-13 in [00-decisions-and-contracts](../design/00-decisions-and-contracts.md)
- **Detail:** [02 §3–§5](../design/02-domain-and-workflow.md#3-approval-policy-32-documented)

## Context

§3.2: claims under a threshold need one approver, above it a second; the thresholds are ours to choose and document. §8 asks for a further tier above a higher threshold, "a variable-length chain without special-casing". Real org charts have gaps: missing managers, a manager who is the claimant, a finance manager who may not approve, one person who would sign two tiers.

## Decision

**Policy is rows.** `approval_policy_tiers(level, code, label, applies_above_minor, resolver, levels_up | designated_user_id, is_active)`, thresholds as exclusive lower bounds in paise:

| Level | Code | Applies when total > | Resolver |
|---|---|---|---|
| 1 | `L1_MANAGER` | ₹0 | 1st manager up the reporting line |
| 2 | `L2_SKIP_LEVEL` | ₹10,000.00 | 2nd manager up |
| 3 | `L3_SENIOR_LEADER` | ₹50,000.00 | 3rd manager up |
| 4 | `L4_CFO` (seeded **inactive**) | ₹2,00,000.00 | designated user (Deepa) |

**The chain is computed once, at submit,** by the pure `buildChain({ tiers, claimant, org, totalMinor })` (`src/server/routing/build-chain.ts`): keep every active tier whose threshold the total exceeds, in level order (lines 68–70; there is no `if (amount > X)` anywhere). Each tier tries its primary, then escalates up the primary's managers, then the single fallback approver. A candidate is eligible if active, `can_approve`, not FINANCE, not the claimant and not already in this chain. No eligible candidate → 422 `ROUTING_UNRESOLVABLE`, and nothing is written; a tier is never dropped and nothing is auto-approved.

**The chain is materialised** as `approval_steps` rows on the new revision (level 1 PENDING, the rest WAITING). Each step copies its tier code, label and threshold, so policy or org-chart edits never touch an in-flight claim. "Who is next" is the WAITING step at level n+1, which the approval of level n activates in the same transaction.

**The database backs it up.** `claims_guard` refuses → SUBMITTED unless the steps match the active tiers for that total exactly (UC012). `approval_steps_guard` re-checks eligibility at insert and again at decision time (UC008), and refuses WAITING → PENDING unless the previous level is APPROVED (UC012). Unique `(submission_id, level)`, `(submission_id, approver_id)` and one PENDING step per submission. The policy is validated at boot (`assertPolicyLoadsWellFormed`) and by the owner script that changes it; `expense_app` can only read tiers.

## Consequences

- Adding or enabling a tier is a data change: `pnpm policy:activate-tier L4_CFO` makes a ₹2,50,000 claim route to four people with no deploy.
- The resolver is unit-testable without a database (identical inputs give deep-equal chains).
- A frozen chain can block: if an approver is deactivated mid-chain the DB refuses their decision. The remedy is recall + resubmit; the runbook lists such claims. A reassign endpoint is the next step.
- Splitting claims to stay under a threshold is a policy gap, not an integrity bug (a finance report, not a constraint).

## Evidence

- TC-U03 (`tests/unit/build-chain.test.ts`) › "₹10,000.00 routes to 1 step", "₹10,000.01 routes to 2 steps", "₹50,000.01 routes to 3 steps", "activating the L4 tier row yields a 4-step chain with no code change", "skips claimant, FINANCE, inactive and non-approver candidates by escalating upward", "a person resolved for two tiers is used once; the later tier escalates to the next distinct approver", "throws ROUTING_UNRESOLVABLE when no eligible candidate exists".
- TC-I16 › "₹10,000.00 → [ravi]; ₹10,000.01 → [ravi, meera]; ₹50,000.01 → [ravi, meera, vikram]", "activating L4 via owner SQL routes ₹2,50,000 to [ravi, meera, vikram, deepa] with no code change", "only level 1 is PENDING at submit; approving level n activates n+1", "stored approvers equal buildChain() for every seeded claim", "vikram's ₹8,000 claim routes to deepa as FALLBACK", "expense_app cannot change approval_policy_tiers".
- TC-I15 › "vikram's ₹25,000 claim returns 422 ROUTING_UNRESOLVABLE and the claim is unchanged", "a raw chain shorter than the applicable tiers is refused with UC012".
- TC-I19 › "an approver demoted to FINANCE mid-chain is refused by the DB (UC008) even if the service check is bypassed".
- Files: `src/server/routing/build-chain.ts`, `src/server/routing/policy.ts`, `src/server/routing/org-loader.ts`, `src/server/repositories/users.repo.ts` (recursive CTE), `scripts/policy-activate-tier.ts`, `prisma/seed-personas.ts`.
