// Records the exact error shapes Prisma 7.10 + @prisma/adapter-pg surface for our DB backstops,
// so readSqlState() can be written against facts. Runs as expense_app.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.ts';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/** The proposed src/server/db/pg-error.ts readSqlState(), under test. */
function readSqlState(err: unknown): string | undefined {
  const e = err as any;
  return (
    e?.meta?.driverAdapterError?.cause?.originalCode ??
    e?.meta?.driverAdapterError?.cause?.code ??
    e?.cause?.originalCode ??
    e?.cause?.code ??
    (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined)
  );
}

function shape(err: any) {
  const pick = (o: any) => o && ({ name: o.name, code: o.code, kind: o.kind, originalCode: o.originalCode, originalMessage: o.originalMessage?.slice?.(0, 90), constraint: o.constraint });
  return {
    ctor: err?.constructor?.name,
    name: err?.name,
    code: err?.code,
    metaKeys: err?.meta ? Object.keys(err.meta) : undefined,
    metaModelName: err?.meta?.modelName,
    driverAdapterError_cause: pick(err?.meta?.driverAdapterError?.cause),
    cause: pick(err?.cause),
    message: String(err?.message ?? '').split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 140),
    readSqlState: readSqlState(err),
  };
}

async function capture(label: string, expected: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    return { label, expected, ok: false, note: 'did not throw' };
  } catch (err) {
    const s = shape(err);
    return { label, expected, ok: s.readSqlState === expected, ...s };
  }
}

const out: any[] = [];
const asha = await prisma.user.findUniqueOrThrow({ where: { email: 'asha.rao@acme.test' } });
const meals = await prisma.category.findUniqueOrThrow({ where: { code: 'MEALS' } });

// a fresh draft with one line, through Prisma (also shows the DB-maintained total coming back)
const draft = await prisma.claim.create({
  data: { claimantId: asha.id, title: 'Prisma probe claim', lineItems: { create: [{ categoryId: meals.id, expenseDate: new Date('2026-10-01'), amountMinor: 4200, description: 'Probe lunch' }] } },
  include: { lineItems: true },
});
out.push({ label: 'nested create returns DB total', totalMinorReturned: draft.totalMinor, claimNumber: draft.claimNumber });
const reread = await prisma.claim.findUniqueOrThrow({ where: { id: draft.id } });
out.push({ label: 'total after re-read', totalMinor: reread.totalMinor });

out.push(await capture('model op: claim.update({ totalMinor })', 'UC003', () => prisma.claim.update({ where: { id: draft.id }, data: { totalMinor: 1 } })));
out.push(await capture('model op: claim.updateMany({ totalMinor })', 'UC003', () => prisma.claim.updateMany({ where: { id: draft.id }, data: { totalMinor: 1 } })));
out.push(await capture('$executeRaw UPDATE total', 'UC003', () => prisma.$executeRaw`UPDATE claims SET total_minor = 1 WHERE id = ${draft.id}::uuid`));
out.push(await capture('$queryRaw (RETURNING) UPDATE total', 'UC003', () => prisma.$queryRaw`UPDATE claims SET total_minor = 1 WHERE id = ${draft.id}::uuid RETURNING id`));
out.push(await capture('model op inside interactive tx', 'UC003', () => prisma.$transaction(async (tx) => { await tx.claim.update({ where: { id: draft.id }, data: { totalMinor: 7 } }); })));
out.push(await capture('lineItem.create with amount 0 (CHECK)', '23514', () => prisma.lineItem.create({ data: { claimId: draft.id, categoryId: meals.id, expenseDate: new Date('2026-10-01'), amountMinor: 0, description: 'zero' } })));
out.push(await capture('session.create duplicate token_hash (unique)', '23505', async () => {
  const t = 'f'.repeat(64);
  const now = new Date(Date.now() + 3_600_000);
  await prisma.session.create({ data: { userId: asha.id, tokenHash: t, idleExpiresAt: now, absoluteExpiresAt: now } });
  await prisma.session.create({ data: { userId: asha.id, tokenHash: t, idleExpiresAt: now, absoluteExpiresAt: now } });
}));
out.push(await capture('future expense date (UC014) via createMany', 'UC014', () => prisma.lineItem.createMany({ data: [{ claimId: draft.id, categoryId: meals.id, expenseDate: new Date('2099-01-01'), amountMinor: 5, description: 'future' }] })));

// SUBMITTED claim (spike b): find one the suite left behind
const submitted = await prisma.claim.findFirstOrThrow({ where: { status: 'SUBMITTED', claimantId: asha.id }, include: { lineItems: true } });
out.push(await capture('lineItem.update on SUBMITTED claim (spike b)', 'UC002', () => prisma.lineItem.update({ where: { id: submitted.lineItems[0].id }, data: { amountMinor: 1 } })));
const approved = await prisma.claim.findFirstOrThrow({ where: { status: 'APPROVED' }, include: { lineItems: true } });
out.push(await capture('lineItem.deleteMany on APPROVED claim', 'UC001', () => prisma.lineItem.deleteMany({ where: { claimId: approved.id } })));

// deferred trigger: error thrown at COMMIT of an interactive transaction (recall without an audit event)
out.push(await capture('COMMIT-time deferred UC015 (interactive tx)', 'UC015', () => prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT id FROM claims WHERE id = ${submitted.id}::uuid FOR NO KEY UPDATE`;
  await tx.approvalStep.updateMany({ where: { submissionId: submitted.currentSubmissionId!, status: { in: ['PENDING', 'WAITING'] } }, data: { status: 'CANCELLED' } });
  await tx.claim.update({ where: { id: submitted.id }, data: { status: 'DRAFT' } });
})));
// deferred trigger: UC009 at COMMIT is owner-only (needs DISABLE TRIGGER), covered by the pg suite.

console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
