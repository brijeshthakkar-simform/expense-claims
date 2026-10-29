// pnpm policy:activate-tier <CODE> [--off] (tsx --conditions=react-server): the owner-run switch
// for one approval_policy_tiers row (D-19, 02 §3.4). `pnpm policy:activate-tier L4_CFO` is the §8
// demo: Asha's next ₹2,50,000 claim routes to [ravi, meera, vikram, deepa] with no code change.
// `--off` deactivates the tier again, so a demo can restore the seeded policy. In-flight chains
// never change: each step copied its tier at submit.
//
// expense_app has SELECT only on the tiers (C-16), so this runs as the OWNER: DATABASE_URL is
// rebound to MIGRATE_DATABASE_URL before any src/server module is imported. One transaction:
// SELECT all tiers FOR UPDATE → set is_active → assertPolicyWellFormed → COMMIT, so a change that
// would leave a malformed policy (a gap in the active levels, say) is rolled back, never served.
// Default import: the named `loadEnvConfig` import fails under tsx in this "type": "module" repo.
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const TAG = '[policy:activate-tier]';
const USAGE = `usage: pnpm policy:activate-tier <CODE> [--off]   e.g. L4_CFO`;

const args = process.argv.slice(2).filter((a) => a !== '--');
const off = args.includes('--off');
const codes = args.filter((a) => a !== '--off');
const code = codes[0];
if (codes.length !== 1 || !code || code.startsWith('-')) {
  console.error(USAGE);
  process.exit(1);
}

const ownerUrl = process.env.MIGRATE_DATABASE_URL;
if (!ownerUrl) {
  console.error(
    `${TAG} MIGRATE_DATABASE_URL is not set (tiers are owner-written; the app role has SELECT only)`,
  );
  process.exit(1);
}
process.env.DATABASE_URL = ownerUrl; // this process only, before any src/server import

const { assertPolicyWellFormed } = await import('../src/server/routing/policy');
const { listAll } = await import('../src/server/repositories/tiers.repo');
const { disconnectDb, getDb } = await import('../src/server/db/client');
const { formatMinor } = await import('../src/shared/money');

const isActive = !off;
let exitCode = 0;
try {
  const result = await getDb().$transaction(async (tx) => {
    // Every tier, locked: two concurrent flips serialise, and the check below sees the final set.
    const locked = await tx.$queryRaw<{ code: string; is_active: boolean }[]>`
      SELECT code, is_active FROM public.approval_policy_tiers ORDER BY level FOR UPDATE`;
    const target = locked.find((t) => t.code === code);
    if (!target)
      throw new Error(`unknown tier ${code}; known tiers: ${locked.map((t) => t.code).join(', ')}`);
    const changed = target.is_active !== isActive;
    if (changed) await tx.approvalPolicyTier.update({ where: { code }, data: { isActive } });
    const tiers = await listAll(tx);
    assertPolicyWellFormed(tiers); // throws → rollback: a malformed policy is never committed
    return { changed, tiers };
  });
  console.log(
    `${TAG} ${code} ${result.changed ? 'is now' : 'was already'} ${isActive ? 'ACTIVE' : 'INACTIVE'}`,
  );
  console.table(
    result.tiers.map((t) => ({
      level: t.level,
      code: t.code,
      label: t.label,
      appliesAbove: `> ${formatMinor(t.appliesAboveMinor)}`,
      resolver: t.resolver,
      active: t.isActive,
    })),
  );
} catch (err) {
  console.error(
    `${TAG} failed, nothing changed: ${err instanceof Error ? err.message : String(err)}`,
  );
  exitCode = 1;
} finally {
  await disconnectDb().catch(() => {});
}
process.exit(exitCode);
