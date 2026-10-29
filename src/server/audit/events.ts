import 'server-only';
import { z } from 'zod';
import { APPROVE_COMMENT_MAX, RECALL_NOTE_MAX, REJECT_REASON_LENGTH } from '@/shared/policy';
import { RESOLVED_VIA } from '@/shared/enums';

// 02 §10.4 / C-20: the six audit event types as one Zod discriminated union. recordEvent() parses
// every event before the insert, so a malformed payload is a programmer bug (500) that rolls the
// transition back; it can never come from user input. One request writes one event; cascaded
// effects (cancelled steps, the activated next level) ride in its payload.

const Uuid = z.uuid();
const Level = z.number().int().min(1);
const Base = {
  claimId: Uuid,
  submissionId: Uuid,
  revision: z.number().int().min(1),
  /** The submission total (= claims.total_minor: lines are frozen while submitted). */
  totalMinor: z.number().int().min(1),
};
const ChainEntry = z.strictObject({
  level: Level,
  tierCode: z.string(),
  approverId: Uuid,
  resolvedVia: z.enum(RESOLVED_VIA),
});
const PreviousRevision = z.strictObject({
  revision: Level,
  totalMinor: z.number().int().min(1),
  outcome: z.enum(['REJECTED', 'RECALLED']),
});
const SubmitPayload = { lineItemCount: z.number().int().min(1), chain: z.array(ChainEntry).min(1) };
const Decision = { level: Level, levelCount: Level, tierCode: z.string() };

export const ClaimEventInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...Base,
    type: z.literal('CLAIM_SUBMITTED'),
    payload: z.strictObject({ ...SubmitPayload, previousRevision: PreviousRevision.optional() }),
  }),
  z.strictObject({
    ...Base,
    type: z.literal('CLAIM_RESUBMITTED'),
    payload: z.strictObject({ ...SubmitPayload, previousRevision: PreviousRevision }),
  }),
  z.strictObject({
    ...Base,
    type: z.literal('STEP_APPROVED'),
    stepId: Uuid,
    reason: z.string().max(APPROVE_COMMENT_MAX).optional(),
    payload: z.strictObject({ ...Decision, nextApproverId: Uuid }),
  }),
  z.strictObject({
    ...Base,
    type: z.literal('CLAIM_APPROVED'),
    stepId: Uuid,
    reason: z.string().max(APPROVE_COMMENT_MAX).optional(),
    payload: z.strictObject({ ...Decision, approverIds: z.array(Uuid).min(1) }),
  }),
  z.strictObject({
    ...Base,
    type: z.literal('CLAIM_REJECTED'),
    stepId: Uuid,
    reason: z.string().trim().min(REJECT_REASON_LENGTH.min).max(REJECT_REASON_LENGTH.max),
    payload: z.strictObject({ ...Decision, cancelledStepIds: z.array(Uuid) }),
  }),
  z.strictObject({
    ...Base,
    type: z.literal('CLAIM_RECALLED'),
    reason: z.string().max(RECALL_NOTE_MAX).optional(),
    payload: z.strictObject({
      cancelledSteps: z.array(
        z.strictObject({
          stepId: Uuid,
          level: Level,
          approverId: Uuid,
          wasStatus: z.enum(['PENDING', 'WAITING']),
        }),
      ),
      approvedLevelsVoided: z.number().int().min(0),
    }),
  }),
]);

/** What a service hands to recordEvent (the actor, request id and transition are added there). */
export type ClaimEventInput = z.input<typeof ClaimEventInputSchema>;
export type ClaimEvent = z.output<typeof ClaimEventInputSchema>;
