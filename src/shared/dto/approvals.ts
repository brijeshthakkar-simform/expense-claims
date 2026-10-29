import { z } from 'zod';
import { PageInfo, UserRef } from '@/shared/dto/claims';
import { ApprovalStepStatus } from '@/shared/enums';

// C-10 / 04 §7.3: the approver queue row (GET /api/v1/approvals). One row per step of mine, with
// the submission it belongs to: `revision` and `amountMinor` are what was submitted for this
// decision (the submission total), `level`/`levelCount`/`tierLabel` say where it sits in the chain.

export const ApprovalTask = z.object({
  stepId: z.uuid(),
  claimId: z.uuid(),
  claimNumber: z.string(),
  title: z.string(),
  claimant: UserRef,
  revision: z.number().int(),
  level: z.number().int(),
  levelCount: z.number().int(),
  tierLabel: z.string(),
  /** The submission total in paise (= the claim total while it is in approval). */
  amountMinor: z.number().int(),
  currency: z.string(),
  /** PENDING (the Pending tab) or APPROVED / REJECTED (the Decided tab). */
  status: ApprovalStepStatus,
  /** When the step became PENDING ("routed to me"); never null for a listed step. */
  activatedAt: z.iso.datetime(),
  /** When I decided (null while PENDING). */
  decidedAt: z.iso.datetime().nullable(),
});
export type ApprovalTask = z.infer<typeof ApprovalTask>;

/** `GET /api/v1/approvals` body: `{ data: ApprovalTask[], page }`. */
export const ApprovalTaskPage = z.object({ data: z.array(ApprovalTask), page: PageInfo });
export type ApprovalTaskPage = z.infer<typeof ApprovalTaskPage>;
