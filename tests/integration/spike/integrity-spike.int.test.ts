// TC-I00, the P0 integrity spike (PLAN P0, D-13 gate): the DB-owned total, the guard, the
// commit-time backstop and the grants work through this stack. Ported from the SQL proof's P0-a…e
// (docs/reference/sql-proof/harness/lib/tests_p0.mjs). P0 had no claims service, so fixtures are
// raw inserts as expense_app, exactly what the proof ran; since P3 case (b) submits through the
// real service (claims_guard v2 refuses a submission pointer that isn't a real submission).
import { describe, expect, it } from 'vitest';
import { getDb } from '@/server/db/client';
import { readSqlState } from '@/server/db/pg-error';
import {
  appClient,
  appSql,
  errorOf,
  ownerClient,
  ownerSql,
  pidOf,
  rejects,
  tx,
  waitUntilBlocked,
  type Sql,
} from '../../helpers/db';
import { submitAs } from '../../helpers/factories';

type ClaimRow = {
  id: string;
  claim_number: string;
  status: string;
  total_minor: number;
  submitted_at: Date | null;
};

async function createDraft(sql: Sql = appSql): Promise<ClaimRow> {
  const [claim] = await sql<ClaimRow>`
    INSERT INTO claims (claimant_id, title)
    VALUES ((SELECT id FROM users WHERE email = 'asha.rao@acme.test'), 'Client visit Pune')
    RETURNING *`;
  return claim!;
}

async function addLine(sql: Sql, claimId: string, amountMinor: number): Promise<{ id: string }> {
  const [line] = await sql<{ id: string }>`
    INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
    VALUES (${claimId}, (SELECT id FROM categories WHERE code = 'MEALS'), DATE '2026-10-01',
            ${amountMinor}, 'Team lunch')
    RETURNING id`;
  return line!;
}

async function claimRow(id: string): Promise<ClaimRow> {
  const [row] = await appSql<ClaimRow>`SELECT * FROM claims WHERE id = ${id}`;
  return row!;
}

/** The parts of a Prisma error that readSqlState() depends on (03 §7.2). */
function prismaErrorShape(err: unknown) {
  const e = err as {
    name?: unknown;
    code?: unknown;
    meta?: { modelName?: unknown; driverAdapterError?: { cause?: Record<string, unknown> } };
  } | null;
  const cause = e?.meta?.driverAdapterError?.cause;
  return {
    name: e?.name,
    code: e?.code,
    metaKeys: e?.meta ? Object.keys(e.meta).sort() : undefined,
    modelName: e?.meta?.modelName,
    cause: cause && {
      kind: cause.kind,
      code: cause.code,
      originalCode: cause.originalCode,
      originalMessage: cause.originalMessage,
    },
  };
}

describe('TC-I00 integrity spike', () => {
  it('(a) app role raw UPDATE claims SET total_minor raises UC003', async () => {
    const claim = await createDraft();
    await addLine(appSql, claim.id, 1500);

    await rejects('UC003', () => appSql`UPDATE claims SET total_minor = 1 WHERE id = ${claim.id}`);

    expect((await claimRow(claim.id)).total_minor).toBe(1500);
  });

  it('(b) Prisma lineItem.update on a SUBMITTED claim raises UC002 and its error shape is recorded', async ({
    annotate,
  }) => {
    const claim = await createDraft();
    const line = await addLine(appSql, claim.id, 2000);
    // A real submit (snapshot, chain, event): the pointer must name this claim's new submission.
    await submitAs('asha', claim);

    const err = await errorOf(() =>
      getDb().lineItem.update({ where: { id: line.id }, data: { amountMinor: 1 } }),
    );

    const shape = prismaErrorShape(err);
    await annotate('Prisma 7.10 + @prisma/adapter-pg error for lineItem.update on SUBMITTED', {
      contentType: 'application/json',
      body: JSON.stringify(shape, null, 2),
      bodyEncoding: 'utf-8',
    });
    expect(readSqlState(err)).toBe('UC002');
    // The shape the SQL proof recorded (docs/reference/sql-proof/README.md §5). A Prisma upgrade
    // that moves the SQLSTATE fails here, before it silently turns 409s into 500s.
    expect(shape).toEqual({
      name: 'PrismaClientKnownRequestError',
      code: 'P2039',
      metaKeys: ['driverAdapterError', 'modelName'],
      modelName: 'LineItem',
      cause: {
        kind: 'postgres',
        code: 'UC002',
        originalCode: 'UC002',
        originalMessage: expect.stringMatching(
          /^CLAIM_NOT_EDITABLE: claim EXP-\d{4}-\d{6,} is in approval; recall it to edit$/,
        ),
      },
    });
    const row = await claimRow(claim.id);
    expect(row).toMatchObject({ status: 'SUBMITTED', total_minor: 2000 });
    expect(row.submitted_at).toBeInstanceOf(Date); // stamped by the DB, not the caller
  });

  it('(c) owner-disabled recompute trigger makes COMMIT fail with UC009', async () => {
    const claim = await createDraft();
    await addLine(appSql, claim.id, 100);
    const owner = await ownerClient();

    await rejects('UC009', () =>
      tx(owner, async () => {
        await owner.query(
          'ALTER TABLE line_items DISABLE TRIGGER line_items_20_recompute_after_insert',
        );
        await addLine(owner.sql, claim.id, 999); // total now lags Σ lines until COMMIT checks it
      }),
    );

    const [trigger] = await ownerSql<{ tgenabled: string }>`
      SELECT tgenabled FROM pg_trigger WHERE tgname = 'line_items_20_recompute_after_insert'`;
    expect(trigger?.tgenabled, 'the DISABLE rolled back with the failed COMMIT').toBe('O');
    expect((await claimRow(claim.id)).total_minor).toBe(100);
  });

  it('(d) app role cannot DISABLE TRIGGER, TRUNCATE or SET session_replication_role (42501)', async () => {
    await rejects('42501', () => appSql`SET session_replication_role = replica`);
    await rejects('42501', () => appSql`ALTER TABLE line_items DISABLE TRIGGER ALL`);
    await rejects(
      '42501',
      () => appSql`ALTER TABLE line_items DISABLE TRIGGER line_items_20_recompute_after_insert`,
    );
    await rejects('42501', () => appSql`ALTER TABLE claims DISABLE TRIGGER claims_10_guard`);
    await rejects('42501', () => appSql`TRUNCATE line_items`);
    await rejects('42501', () => appSql`TRUNCATE claims CASCADE`);
  });

  it('(e) two connections inserting lines into one claim serialize and the total is 300', async () => {
    const claim = await createDraft();
    const [first, second] = await Promise.all([appClient(), appClient()]);
    // Read the pid first: a pg Client queues later queries behind a blocked one (07 §3.4).
    const secondPid = await pidOf(second);

    await first.query('BEGIN');
    await addLine(first.sql, claim.id, 100); // the BEFORE trigger now holds the claim row lock
    await second.query('BEGIN');
    const secondInsert = addLine(second.sql, claim.id, 200);
    secondInsert.catch(() => {});

    const waitedOn = await waitUntilBlocked(secondPid); // proven in pg_stat_activity, not slept
    await first.query('COMMIT');
    await secondInsert;
    await second.query('COMMIT');

    expect(waitedOn).toMatch(/^Lock\//);
    expect((await claimRow(claim.id)).total_minor).toBe(300);
    expect(await appSql`SELECT * FROM v_claim_total_drift`).toEqual([]);
  });
});
