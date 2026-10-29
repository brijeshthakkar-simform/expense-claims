// TC-U04 (§4-b, §3.4/§3.5 UI actions): decide() is the one state machine for both the service's 409
// codes and ClaimDetail.allowedActions (04 §4.4). The expectations below are written out from the
// 04 §4.3 matrix and the 04 §6.3 action × status table, not derived from the code under test.
// submissionOutcome (D-18, 02 §2.3) landed with P4's decisions.
import { describe, expect, it } from 'vitest';
import type { Actor } from '@/server/auth/actor';
import {
  allowedActions,
  decide,
  submissionOutcome,
  type ClaimFacts,
} from '@/server/authz/claim-policy';
import { isErrorCode } from '@/server/errors/codes';
import {
  APPROVAL_STEP_STATUSES,
  CLAIM_ACTIONS,
  type ApprovalStepStatus,
  type ClaimAction,
  type ClaimStatus,
  type SubmissionOutcome,
} from '@/shared/enums';

const actor = (id: string, o: Partial<Actor> = {}): Actor => ({
  id,
  email: `${id}@acme.test`,
  name: id,
  role: 'EMPLOYEE',
  canApprove: false,
  ...o,
});
const ASHA = actor('asha'); // the claimant: an employee who is not an approver
const RAVI = actor('ravi', { canApprove: true });

/** The claim's state: status plus revision (a recalled draft has revision ≥ 1). */
const STATES = [
  { label: 'never-submitted DRAFT', status: 'DRAFT', currentRevision: 0 },
  { label: 'recalled DRAFT', status: 'DRAFT', currentRevision: 1 },
  { label: 'SUBMITTED', status: 'SUBMITTED', currentRevision: 1 },
  { label: 'APPROVED', status: 'APPROVED', currentRevision: 1 },
  { label: 'REJECTED', status: 'REJECTED', currentRevision: 1 },
] as const satisfies readonly { label: string; status: ClaimStatus; currentRevision: number }[];
type StateLabel = (typeof STATES)[number]['label'];

/** The caller's relationship to Asha's claim (04 §4.1), as an actor plus their step, if any. */
const RELATIONSHIPS = [
  { label: 'owner', who: ASHA, step: null },
  { label: 'owner who is an approver', who: RAVI, step: null, owns: true },
  { label: 'active approver', who: RAVI, step: 'PENDING' },
  { label: 'waiting approver', who: RAVI, step: 'WAITING' },
  { label: 'decided approver (approved)', who: RAVI, step: 'APPROVED' },
  { label: 'decided approver (rejected)', who: RAVI, step: 'REJECTED' },
  { label: 'cancelled approver', who: RAVI, step: 'CANCELLED' },
  { label: 'unrelated approver', who: actor('neha', { canApprove: true }), step: null },
  { label: 'finance', who: actor('farah', { role: 'FINANCE' }), step: null },
  { label: 'unrelated employee', who: actor('arjun'), step: null },
  { label: 'admin', who: actor('admin', { role: 'ADMIN' }), step: null },
] as const satisfies readonly {
  label: string;
  who: Actor;
  step: ApprovalStepStatus | null;
  owns?: boolean;
}[];

const OK = 'ok';
type Expected = typeof OK | string;

/** 04 §6.3: owner actions by status (the owner's view of EDIT/SUBMIT/RECALL/DELETE). */
const OWNER_ACTIONS: Record<
  StateLabel,
  Record<'EDIT' | 'SUBMIT' | 'RECALL' | 'DELETE', Expected>
> = {
  'never-submitted DRAFT': {
    EDIT: OK,
    SUBMIT: OK,
    RECALL: 'INVALID_STATUS_TRANSITION',
    DELETE: OK,
  },
  'recalled DRAFT': {
    EDIT: OK,
    SUBMIT: OK,
    RECALL: 'INVALID_STATUS_TRANSITION',
    DELETE: 'CLAIM_HAS_HISTORY',
  },
  SUBMITTED: {
    EDIT: 'CLAIM_NOT_EDITABLE',
    SUBMIT: 'INVALID_STATUS_TRANSITION',
    RECALL: OK,
    DELETE: 'CLAIM_HAS_HISTORY',
  },
  APPROVED: {
    EDIT: 'CLAIM_LOCKED',
    SUBMIT: 'CLAIM_LOCKED',
    RECALL: 'CLAIM_LOCKED',
    DELETE: 'CLAIM_LOCKED',
  },
  REJECTED: {
    EDIT: OK,
    SUBMIT: OK,
    RECALL: 'INVALID_STATUS_TRANSITION',
    DELETE: 'CLAIM_HAS_HISTORY',
  },
};

/** 04 §4.3 / §6.2: approve and reject depend on role and on my step, never on ownership. */
const DECISION: Record<(typeof RELATIONSHIPS)[number]['label'], Expected> = {
  owner: 'FORBIDDEN', // no can_approve
  'owner who is an approver': 'NOT_IN_YOUR_QUEUE', // routing never picks the claimant
  'active approver': OK,
  'waiting approver': 'NOT_IN_YOUR_QUEUE',
  'decided approver (approved)': 'ALREADY_DECIDED',
  'decided approver (rejected)': 'ALREADY_DECIDED',
  'cancelled approver': 'NOT_IN_YOUR_QUEUE',
  'unrelated approver': 'NOT_IN_YOUR_QUEUE',
  finance: 'FORBIDDEN',
  'unrelated employee': 'FORBIDDEN',
  admin: 'FORBIDDEN',
};

function expected(
  rel: (typeof RELATIONSHIPS)[number],
  state: StateLabel,
): Record<ClaimAction, Expected> {
  const owner = rel.label === 'owner' || ('owns' in rel && rel.owns);
  const ownerAction = (a: 'EDIT' | 'SUBMIT' | 'RECALL' | 'DELETE') =>
    owner ? OWNER_ACTIONS[state][a] : 'CLAIM_NOT_FOUND'; // never an existence or state oracle
  return {
    EDIT: ownerAction('EDIT'),
    SUBMIT: ownerAction('SUBMIT'),
    RECALL: ownerAction('RECALL'),
    DELETE: ownerAction('DELETE'),
    APPROVE: DECISION[rel.label],
    REJECT: DECISION[rel.label],
  };
}

const factsFor = (
  rel: (typeof RELATIONSHIPS)[number],
  s: (typeof STATES)[number],
  step: ApprovalStepStatus | null = rel.step,
): ClaimFacts => ({
  status: s.status,
  currentRevision: s.currentRevision,
  claimantId: rel.label === 'owner' || ('owns' in rel && rel.owns) ? rel.who.id : ASHA.id,
  myStepOnCurrentRevision: step,
});

describe('TC-U04 claim policy', () => {
  it('decide() is exhaustive over status × relationship × action', () => {
    let cells = 0;
    for (const s of STATES)
      for (const rel of RELATIONSHIPS) {
        const d = decide(rel.who, factsFor(rel, s));
        expect(Object.keys(d).sort(), 'one decision per action, no more, no fewer').toEqual(
          [...CLAIM_ACTIONS].sort(),
        );
        const got = Object.fromEntries(
          CLAIM_ACTIONS.map((a) => {
            const x = d[a];
            if (!x.ok)
              expect(isErrorCode(x.code), `${a}: ${x.code} is in the catalogue`).toBe(true);
            return [a, x.ok ? OK : x.code];
          }),
        );
        expect([s.label, rel.label, got]).toEqual([s.label, rel.label, expected(rel, s.label)]);
        // allowedActions is exactly the allowed subset, in the canonical order
        expect(allowedActions(rel.who, factsFor(rel, s))).toEqual(
          CLAIM_ACTIONS.filter((a) => d[a].ok),
        );
        cells += CLAIM_ACTIONS.length;
      }
    expect(cells).toBe(STATES.length * RELATIONSHIPS.length * CLAIM_ACTIONS.length);

    // 04 §4.3, the SUBMITTED column's allowedActions as the UI receives them
    const submitted = STATES[2];
    const actionsOf = (label: string) => {
      const rel = RELATIONSHIPS.find((r) => r.label === label)!;
      return allowedActions(rel.who, factsFor(rel, submitted));
    };
    expect(actionsOf('owner')).toEqual(['RECALL']);
    expect(actionsOf('active approver')).toEqual(['APPROVE', 'REJECT']);
    expect(actionsOf('decided approver (approved)')).toEqual([]);
    expect(actionsOf('finance')).toEqual([]);
  });

  it('allowedActions for FINANCE is always empty', () => {
    const farah = actor('farah', { role: 'FINANCE' });
    // A finance user with can_approve is impossible (CHECK users_finance_cannot_approve), but the
    // function must not depend on that: FINANCE never decides.
    for (const who of [farah, { ...farah, canApprove: true }])
      for (const s of STATES)
        for (const step of [null, ...APPROVAL_STEP_STATUSES]) {
          const facts: ClaimFacts = {
            status: s.status,
            currentRevision: s.currentRevision,
            claimantId: ASHA.id, // someone else's claim
            myStepOnCurrentRevision: step,
          };
          expect([s.label, step, allowedActions(who, facts)]).toEqual([s.label, step, []]);
        }
  });

  it('allowedActions offers DELETE only for never-submitted drafts', () => {
    const statuses: ClaimStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'];
    for (const rel of RELATIONSHIPS)
      for (const status of statuses)
        for (const currentRevision of [0, 1, 2]) {
          const facts = { ...factsFor(rel, STATES[0]), status, currentRevision };
          const owner = facts.claimantId === rel.who.id;
          const offered = allowedActions(rel.who, facts).includes('DELETE');
          expect([rel.label, status, currentRevision, offered]).toEqual([
            rel.label,
            status,
            currentRevision,
            owner && status === 'DRAFT' && currentRevision === 0,
          ]);
        }
  });

  it('submissionOutcome derives IN_APPROVAL, APPROVED, REJECTED and RECALLED from steps', () => {
    const P: ApprovalStepStatus = 'PENDING';
    const W: ApprovalStepStatus = 'WAITING';
    const A: ApprovalStepStatus = 'APPROVED';
    const R: ApprovalStepStatus = 'REJECTED';
    const C: ApprovalStepStatus = 'CANCELLED';
    // Every chain shape the workflow can produce (02 §2.2 step transitions), level order
    const CHAINS: [readonly ApprovalStepStatus[], SubmissionOutcome, string][] = [
      [[P], 'IN_APPROVAL', 'just submitted, 1 step'],
      [[P, W, W], 'IN_APPROVAL', 'just submitted, 3 steps'],
      [[A, P, W], 'IN_APPROVAL', 'level 1 approved'],
      [[A, A, P], 'IN_APPROVAL', 'at the last level'],
      [[A], 'APPROVED', 'final approval, 1 step'],
      [[A, A, A, A], 'APPROVED', 'final approval, 4 steps'],
      [[R], 'REJECTED', 'rejected at level 1 of 1'],
      [[R, C, C], 'REJECTED', 'rejected at level 1, later levels cancelled'],
      [[A, R, C], 'REJECTED', 'rejected at level 2'],
      [[A, A, R], 'REJECTED', 'rejected at the last level'],
      [[C], 'RECALLED', 'recalled before any decision, 1 step'],
      [[C, C, C], 'RECALLED', 'recalled before any decision'],
      [[A, C, C], 'RECALLED', 'recalled after level 1 approved'],
      [[A, A, C], 'RECALLED', 'recalled at the last level'],
    ];
    for (const [statuses, outcome, story] of CHAINS)
      expect([story, submissionOutcome(statuses.map((status) => ({ status })))]).toEqual([
        story,
        outcome,
      ]);
    // Stable: the same steps always give the same answer, whatever order they arrive in
    for (const [statuses, outcome] of CHAINS)
      expect(submissionOutcome([...statuses].reverse().map((status) => ({ status })))).toBe(
        outcome,
      );
    // A rejection wins over everything else; all-approved needs every step
    expect(submissionOutcome([A, A, A].map((status) => ({ status })))).toBe('APPROVED');
    expect(submissionOutcome([A, A, W].map((status) => ({ status })))).toBe('IN_APPROVAL');
    // Exhaustive over 2-step chains: exactly one outcome each, and it is one of the four
    const outcomes = new Set<SubmissionOutcome>();
    for (const x of APPROVAL_STEP_STATUSES)
      for (const y of APPROVAL_STEP_STATUSES)
        outcomes.add(submissionOutcome([{ status: x }, { status: y }]));
    expect([...outcomes].sort()).toEqual(['APPROVED', 'IN_APPROVAL', 'RECALLED', 'REJECTED']);
  });
});
