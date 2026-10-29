// TC-I18 (§3.5-a/b/c, §6-4, RT-m1): the 04 §4.3 visibility and permission matrix, one row per
// (relationship, action), driven through the real route handlers. The expected cells are copied
// from 04 §4.3 (a SUBMITTED claim) and the 02 §2.4 / 04 §6.3 action × status table, not derived
// from the code under test.
//
// Fixture F1 (07 §6.2 notes): Asha ₹75,000 → [ravi, meera, vikram], then Ravi approves L1. So
// owner = asha, decided = ravi, active = meera, waiting = vikram, unrelated approver = neha,
// finance = farah, unrelated employee = arjun. resetDb() runs before every row, so each row gets
// a fresh F1 and a successful approve/reject/recall can't leak into the next row.
// P5 adds the recall and history columns and fixture F2 (the cancelled approver): Asha ₹25,000 →
// [ravi, meera], Ravi approves, Asha recalls, edits it to ₹8,000 and resubmits → [ravi]. Meera's
// PENDING step became CANCELLED, so she is the cancelled approver.
import { describe, expect, it } from 'vitest';
import * as approveRoute from '@/app/api/v1/claims/[claimId]/approve/route';
import * as historyRoute from '@/app/api/v1/claims/[claimId]/history/route';
import * as recallRoute from '@/app/api/v1/claims/[claimId]/recall/route';
import * as rejectRoute from '@/app/api/v1/claims/[claimId]/reject/route';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import * as submitRoute from '@/app/api/v1/claims/[claimId]/submit/route';
import type { ClaimDetail } from '@/shared/dto/claims';
import type { ClaimHistory } from '@/shared/dto/history';
import type { Persona } from '../../helpers/auth';
import { ownerSql } from '../../helpers/db';
import {
  approveAs,
  lineInput,
  makeDraft,
  recallAs,
  rejectAs,
  submitAs,
} from '../../helpers/factories';
import { callRoute, type Method, type RouteModule } from '../../helpers/http';

const RELATIONSHIPS = {
  owner: 'asha',
  'active approver': 'meera',
  'waiting approver': 'vikram',
  'decided approver': 'ravi',
  'unrelated approver': 'neha',
  finance: 'farah',
  'unrelated employee': 'arjun',
} as const satisfies Record<string, Persona>;
type Relationship = keyof typeof RELATIONSHIPS;

const ACTIONS = [
  'GET',
  'PUT',
  'DELETE',
  'submit',
  'recall',
  'approve',
  'reject',
  'history',
] as const;
type Action = (typeof ACTIONS)[number];

/**
 * 04 §4.3, SUBMITTED column by column. A 200 GET's last cell is its allowedActions; a 200
 * decision, recall or history read is OK.
 */
const MATRIX: Record<Relationship, Record<Action, [number, string]>> = {
  owner: {
    GET: [200, '[RECALL]'],
    PUT: [409, 'CLAIM_NOT_EDITABLE'],
    DELETE: [409, 'CLAIM_HAS_HISTORY'],
    submit: [409, 'INVALID_STATUS_TRANSITION'],
    recall: [200, 'OK'],
    approve: [403, 'FORBIDDEN'], // Asha has no can_approve
    reject: [403, 'FORBIDDEN'],
    history: [200, 'OK'],
  },
  'active approver': {
    GET: [200, '[APPROVE,REJECT]'],
    PUT: [404, 'CLAIM_NOT_FOUND'],
    DELETE: [404, 'CLAIM_NOT_FOUND'],
    submit: [404, 'CLAIM_NOT_FOUND'],
    recall: [404, 'CLAIM_NOT_FOUND'],
    approve: [200, 'OK'],
    reject: [200, 'OK'],
    history: [200, 'OK'],
  },
  'waiting approver': {
    GET: [404, 'CLAIM_NOT_FOUND'],
    PUT: [404, 'CLAIM_NOT_FOUND'],
    DELETE: [404, 'CLAIM_NOT_FOUND'],
    submit: [404, 'CLAIM_NOT_FOUND'],
    recall: [404, 'CLAIM_NOT_FOUND'],
    approve: [403, 'NOT_IN_YOUR_QUEUE'],
    reject: [403, 'NOT_IN_YOUR_QUEUE'],
    history: [404, 'CLAIM_NOT_FOUND'],
  },
  'decided approver': {
    GET: [200, '[]'],
    PUT: [404, 'CLAIM_NOT_FOUND'],
    DELETE: [404, 'CLAIM_NOT_FOUND'],
    submit: [404, 'CLAIM_NOT_FOUND'],
    recall: [404, 'CLAIM_NOT_FOUND'],
    approve: [409, 'ALREADY_DECIDED'],
    reject: [409, 'ALREADY_DECIDED'],
    history: [200, 'OK'],
  },
  'unrelated approver': {
    GET: [404, 'CLAIM_NOT_FOUND'],
    PUT: [404, 'CLAIM_NOT_FOUND'],
    DELETE: [404, 'CLAIM_NOT_FOUND'],
    submit: [404, 'CLAIM_NOT_FOUND'],
    recall: [404, 'CLAIM_NOT_FOUND'],
    approve: [403, 'NOT_IN_YOUR_QUEUE'],
    reject: [403, 'NOT_IN_YOUR_QUEUE'],
    history: [404, 'CLAIM_NOT_FOUND'],
  },
  finance: {
    GET: [200, '[]'],
    PUT: [404, 'CLAIM_NOT_FOUND'],
    DELETE: [404, 'CLAIM_NOT_FOUND'],
    submit: [404, 'CLAIM_NOT_FOUND'],
    recall: [404, 'CLAIM_NOT_FOUND'],
    approve: [403, 'FORBIDDEN'],
    reject: [403, 'FORBIDDEN'],
    history: [200, 'OK'],
  },
  'unrelated employee': {
    GET: [404, 'CLAIM_NOT_FOUND'],
    PUT: [404, 'CLAIM_NOT_FOUND'],
    DELETE: [404, 'CLAIM_NOT_FOUND'],
    submit: [404, 'CLAIM_NOT_FOUND'],
    recall: [404, 'CLAIM_NOT_FOUND'],
    approve: [403, 'FORBIDDEN'], // Arjun has no can_approve
    reject: [403, 'FORBIDDEN'],
    history: [404, 'CLAIM_NOT_FOUND'],
  },
};

const ROWS = (Object.keys(MATRIX) as Relationship[]).flatMap((rel) =>
  ACTIONS.map((action) => [rel, action, ...MATRIX[rel][action]] as const),
);

/** Fixture F1: Asha ₹75,000 → [ravi, meera, vikram], Ravi has approved L1. */
async function fixtureF1(): Promise<ClaimDetail> {
  const draft = await makeDraft('asha', {
    title: 'Offsite venue deposit',
    lines: [{ amountMinor: 7_500_000 }],
  });
  const c = await approveAs('ravi', await submitAs('asha', draft));
  expect(c.approval?.steps.map((s) => `${s.approver.name.split(' ')[0]}:${s.status}`)).toEqual([
    'Ravi:APPROVED',
    'Meera:PENDING',
    'Vikram:WAITING',
  ]);
  return c;
}

/** One action as one HTTP request (the body is valid, so only authorization and state decide). */
function request(action: Action, c: ClaimDetail): [RouteModule, Method, string, unknown] {
  const base = `/api/v1/claims/${c.id}`;
  switch (action) {
    case 'GET':
      return [claimRoute, 'GET', base, undefined];
    case 'PUT':
      return [claimRoute, 'PUT', base, { title: 'Hijacked', lineItems: [] }];
    case 'DELETE':
      return [claimRoute, 'DELETE', base, undefined];
    case 'submit':
      return [submitRoute, 'POST', `${base}/submit`, undefined];
    case 'recall':
      return [recallRoute, 'POST', `${base}/recall`, { note: 'Adding the venue invoice' }];
    case 'history':
      return [historyRoute, 'GET', `${base}/history`, undefined];
    case 'approve':
      return [approveRoute, 'POST', `${base}/approve`, { revision: c.currentRevision }];
    case 'reject':
      return [
        rejectRoute,
        'POST',
        `${base}/reject`,
        { revision: c.currentRevision, reason: 'Venue quote is not itemised' },
      ];
  }
}

async function send(as: Persona, action: Action, c: ClaimDetail) {
  const [mod, method, path, body] = request(action, c);
  return callRoute(mod, method, { path, params: { claimId: c.id }, body, as });
}

/** The claim's whole workflow footprint: a refused request must leave it byte-identical. */
const footprint = (claimId: string) => ownerSql`SELECT
    (SELECT row_to_json(c)::text FROM claims c WHERE c.id = ${claimId}) AS claim,
    (SELECT json_agg(s ORDER BY s.level)::text FROM approval_steps s WHERE s.claim_id = ${claimId}) AS steps,
    (SELECT json_agg(l ORDER BY l.id)::text FROM line_items l WHERE l.claim_id = ${claimId}) AS lines,
    (SELECT count(*)::int FROM claim_events e WHERE e.claim_id = ${claimId}) AS events`;

describe('TC-I18 visibility matrix (fixture F1)', () => {
  it.each(ROWS)('%s %s → %i %s', async (rel, action, status, code) => {
    const c = await fixtureF1();
    const before = await footprint(c.id);
    const res = await send(RELATIONSHIPS[rel], action, c);
    const body = (await res.json()) as { data?: ClaimDetail; error?: { code: string } };

    let got: string;
    if (res.status !== 200) got = body.error!.code;
    else if (action === 'GET') got = `[${body.data!.allowedActions.join(',')}]`;
    else got = 'OK';
    expect([rel, action, res.status, got]).toEqual([rel, action, status, code]);

    if (res.status !== 200) {
      expect(await footprint(c.id)).toEqual(before); // a refusal changes nothing
    } else if (action === 'GET') {
      expect(body.data).toMatchObject({
        id: c.id,
        status: 'SUBMITTED',
        claimNumber: c.claimNumber,
      });
      expect(await footprint(c.id)).toEqual(before); // a read changes nothing
    } else if (action === 'history') {
      const h = body.data as unknown as ClaimHistory;
      expect(h.submissions.map((s) => [s.revision, s.outcome])).toEqual([[1, 'IN_APPROVAL']]);
      expect(h.events.map((e) => e.type)).toEqual(['CLAIM_SUBMITTED', 'STEP_APPROVED']);
      expect(await footprint(c.id)).toEqual(before);
    } else if (action === 'recall') {
      // the owner took it back: L1 stays APPROVED, the open levels are CANCELLED, one more event
      expect(body.data).toMatchObject({
        status: 'DRAFT',
        currentRevision: 1,
        allowedActions: ['EDIT', 'SUBMIT'],
      });
      expect(body.data!.approval!.steps.map((s) => s.status)).toEqual([
        'APPROVED',
        'CANCELLED',
        'CANCELLED',
      ]);
      expect((await footprint(c.id))[0]).toMatchObject({ events: 3 });
    } else {
      // the active approver's decision went through: Meera's step is decided, one more event
      const steps = body.data!.approval!.steps.map((s) => s.status);
      expect(steps).toEqual(
        action === 'approve'
          ? ['APPROVED', 'APPROVED', 'PENDING']
          : ['APPROVED', 'REJECTED', 'CANCELLED'],
      );
      expect(body.data!.allowedActions).toEqual([]); // now a decided approver: read-only
    }
  });

  it('finance can GET any claim including drafts and every write returns 404 or 403 FORBIDDEN', async () => {
    const draft = await makeDraft('asha', { lines: [{ amountMinor: 120_000 }] }); // never submitted
    const f1 = await fixtureF1();
    const approved = await approveAs(
      'ravi',
      await submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] })),
    );
    const rejected = await rejectAs(
      'ravi',
      await submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor: 1_200_000 }] })),
    );
    const claims = { DRAFT: draft, SUBMITTED: f1, APPROVED: approved, REJECTED: rejected };

    for (const [status, c] of Object.entries(claims)) {
      const before = await footprint(c.id);
      const get = await send('farah', 'GET', c);
      expect([status, get.status]).toEqual([status, 200]);
      const detail = ((await get.json()) as { data: ClaimDetail }).data;
      expect(detail).toMatchObject({ id: c.id, status, allowedActions: [] }); // read-only

      const history = await send('farah', 'history', c);
      expect([status, 'history', history.status]).toEqual([status, 'history', 200]);

      for (const action of ACTIONS.filter((a) => a !== 'GET' && a !== 'history')) {
        const res = await send('farah', action, c);
        const { code } = ((await res.json()) as { error: { code: string } }).error;
        const want: [number, string] =
          action === 'approve' || action === 'reject'
            ? [403, 'FORBIDDEN']
            : [404, 'CLAIM_NOT_FOUND'];
        expect([status, action, res.status, code]).toEqual([status, action, ...want]);
      }
      expect(await footprint(c.id)).toEqual(before); // and nothing changed
    }
  });
});

/** Fixture F2: Asha ₹25,000 → [ravi, meera]; Ravi approves; Asha recalls, edits to ₹8,000 and
 * resubmits → [ravi]. Meera's step (PENDING when recalled) is CANCELLED: the cancelled approver. */
async function fixtureF2(): Promise<ClaimDetail> {
  const draft = await makeDraft('asha', {
    title: 'Design workshop',
    lines: [{ amountMinor: 2_500_000 }],
  });
  const recalled = await recallAs('asha', await approveAs('ravi', await submitAs('asha', draft)));
  const edit = await callRoute(claimRoute, 'PUT', {
    path: `/api/v1/claims/${draft.id}`,
    params: { claimId: draft.id },
    body: {
      title: recalled.title,
      lineItems: [{ ...lineInput(recalled.lineItems[0]!), amountMinor: 800_000 }],
    },
    as: 'asha',
  });
  expect(edit.status).toBe(200);
  const c = await submitAs('asha', draft);
  const steps = await ownerSql<{ s: string }>`
    SELECT 'r' || sub.revision || ':' || split_part(u.email, '.', 1) || ':' || st.status AS s
      FROM approval_steps st
      JOIN claim_submissions sub ON sub.id = st.submission_id
      JOIN users u ON u.id = st.approver_id
     WHERE st.claim_id = ${c.id} ORDER BY sub.revision, st.level`;
  expect(steps.map((r) => r.s)).toEqual([
    'r1:ravi:APPROVED',
    'r1:meera:CANCELLED',
    'r2:ravi:PENDING',
  ]);
  return c;
}

/** 04 §4.3, the "Cancelled approver" column: nothing to read, nothing to decide. */
const CANCELLED_APPROVER: Record<Action, [number, string]> = {
  GET: [404, 'CLAIM_NOT_FOUND'],
  PUT: [404, 'CLAIM_NOT_FOUND'],
  DELETE: [404, 'CLAIM_NOT_FOUND'],
  submit: [404, 'CLAIM_NOT_FOUND'],
  recall: [404, 'CLAIM_NOT_FOUND'],
  approve: [403, 'NOT_IN_YOUR_QUEUE'],
  reject: [403, 'NOT_IN_YOUR_QUEUE'],
  history: [404, 'CLAIM_NOT_FOUND'],
};

describe('TC-I18 visibility matrix (fixture F2)', () => {
  it.each(ACTIONS.map((a) => ['cancelled approver', a, ...CANCELLED_APPROVER[a]] as const))(
    '%s %s → %i %s',
    async (rel, action, status, code) => {
      const c = await fixtureF2();
      const before = await footprint(c.id);
      const res = await send('meera', action, c);
      const body = (await res.json()) as { error?: { code: string } };
      expect([rel, action, res.status, body.error?.code ?? 'OK']).toEqual([
        rel,
        action,
        status,
        code,
      ]);
      expect(await footprint(c.id)).toEqual(before); // a refusal changes nothing
    },
  );
});
