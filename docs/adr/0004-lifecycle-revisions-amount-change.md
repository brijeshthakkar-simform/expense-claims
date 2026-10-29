# ADR-0004: Lifecycle, immutable revisions, the amount-change rule, and receipts per line

- **Status:** Accepted (Phases 3–6; final 2026-10-16)
- **Decision ids:** D-15, D-16, D-17, D-18, D-30, D-31 in [00-decisions-and-contracts](../design/00-decisions-and-contracts.md)
- **Detail:** [02 §2, §6, §7](../design/02-domain-and-workflow.md), [06 §5](../design/06-cross-cutting.md)

## Context

The brief leaves three choices to us and asks that we document them: what happens when the amount changes after routing has started (§3.2), whether receipts hang off the claim or the line (§3.1), and how a rejected claim returns for edit without losing its reason or history (§3.3). §3.4 adds that an approved claim is read-only, attachments included. The risk to avoid is an approver signing content that changes under them.

## Decision

**Lifecycle.** Four statuses: DRAFT, SUBMITTED, APPROVED (terminal), REJECTED. Title, lines and receipts are editable only while DRAFT or REJECTED; a REJECTED claim stays REJECTED while being edited, so the reason banner stays. One endpoint (`POST …/submit`) handles first submit and resubmit.

**Revisions.** Every submit inserts a `claim_submissions` row (revision N+1) whose JSON snapshot of title, lines and receipts the database checks against the live rows (`claim_submissions_verify`, UC016) and then freezes (INSERT-only). The chain is built fresh for that revision. Decided steps never change (UC006), and every event is append-only.

**Amount-change rule.** Content is frozen while SUBMITTED: `PUT`, receipt upload and delete return 409 `CLAIM_NOT_EDITABLE` with `hint: RECALL_TO_EDIT`, and the DB raises UC002. The claimant may **recall** until the final approval. Recall cancels the open steps (kept as CANCELLED), leaves APPROVED steps in history on that revision and returns the claim to DRAFT. The next submit builds a **brand-new chain from the new total**; earlier approvals never carry over. Approve and reject bodies must carry `revision`; a stale one gets 409 `REVISION_MISMATCH`.

**Receipts per line item.** Optional for submission. Up to 5 per line; jpeg, png, webp or pdf; ≤ 10 MiB; the declared type must match the magic bytes; sha256 is stored and copied into the snapshot. Uploads are server-proxied multipart: size and type are checked first, the object is written under a fresh key outside any transaction, then the row is inserted under the claim lock (on failure the object is deleted). Downloads stream through the app after the visibility check, as `attachment` with `nosniff`. Receipts lock with the claim (`receipts_before_write` → `assert_claim_editable`: UC001 approved, UC002 submitted).

**Retention.** A storage object is deleted only when its claim was never submitted (`current_revision = 0`). An object that any snapshot references is kept, and stays downloadable after its line is removed.

Rejected alternatives: editing before the first approval with automatic re-routing (two chain builders and an approver race); keeping approvals when the tier count is unchanged (approvals bind to content, not to an amount bucket); per-claim receipts (finance can't tell which line lacks evidence); presigned uploads in core (no size cap before storing).

## Consequences

- No time-of-check/time-of-use race: an approver always decides the exact revision they saw.
- One chain builder ([ADR-0005](0005-data-driven-routing.md)) serves submit, resubmit and the seed.
- History is complete: `GET …/history` returns every revision with its outcome and chain, and every event.
- Cost: after a recall, approvers who already signed must sign again. Approved evidence objects are never garbage-collected.

## Evidence

- TC-I21 › "line items cannot be edited while SUBMITTED (409 CLAIM_NOT_EDITABLE)", "recall after L1 approved: L1 stays APPROVED on revision 1, open steps CANCELLED, claim DRAFT, CLAIM_RECALLED event", "resubmitting at a higher amount builds a fresh chain from the new total (1 → 3 steps)", "recalling an APPROVED claim returns 409 CLAIM_LOCKED".
- TC-I22 › "preserved vs reset: claim number, events, reasons and prior steps preserved; status, chain and editability reset", "after edit and resubmit, revision 1 snapshot, steps and reason are unchanged", "receipts referenced by revision 1 stay downloadable after the line is deleted".
- TC-I11 › "PUT on a SUBMITTED claim returns 409 CLAIM_NOT_EDITABLE with hint RECALL_TO_EDIT"; TC-I19 › "stale revision returns 409 REVISION_MISMATCH"; TC-I20 › "approve racing recall: on the final level exactly one wins; on an intermediate level both succeed in lock order; status, steps and events agree".
- TC-I15 › "a forged snapshot that disagrees with the live lines is refused with UC016".
- TC-I27 › "owner uploads a PDF to a DRAFT line → 201 with sha256", "an .exe renamed to .pdf returns 422 RECEIPT_TYPE_NOT_ALLOWED", "the 6th receipt on a line returns 422 RECEIPT_LIMIT_REACHED", "raw DELETE FROM receipts on an APPROVED claim raises UC001", "deleting a receipt on a previously submitted claim keeps the object", "a failed DB insert deletes the uploaded object".
- Seed: C05 (rejected by Ravi), C06 (rev 1 rejected at ₹30,000, rev 2 at ₹9,500 with a 1-step chain), C07 (recalled after L1), C04 (approved, with a seeded PDF receipt on line 1).
- Files: `src/server/services/lifecycle.service.ts`, `src/server/services/receipts.service.ts`, `src/server/authz/claim-policy.ts`, migrations `20261016090000_workflow` and `20261021090000_receipts`.
