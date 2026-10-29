// Reference data (seeded as the OWNER, like prisma/seed.ts in the migrate job) and a minimal
// "service layer" that runs as expense_app and follows canonical C-25 write orders exactly.
import { randomUUID } from 'node:crypto';
import { tx } from './harness.mjs';

export const CAST = [
  // email, name, code, dept, role, canApprove, fallback, manager
  ['vikram.shah@acme.test', 'Vikram Shah', 'E1004', 'EXEC', 'EMPLOYEE', true, false, null],
  ['admin@acme.test', 'Site Admin', 'E1009', 'EXEC', 'ADMIN', false, false, null],
  ['meera.iyer@acme.test', 'Meera Iyer', 'E1003', 'ENG', 'EMPLOYEE', true, false, 'vikram.shah@acme.test'],
  ['deepa.menon@acme.test', 'Deepa Menon', 'E1005', 'FIN', 'EMPLOYEE', true, true, 'vikram.shah@acme.test'],
  ['ravi.menon@acme.test', 'Ravi Menon', 'E1002', 'ENG', 'EMPLOYEE', true, false, 'meera.iyer@acme.test'],
  ['neha.kapoor@acme.test', 'Neha Kapoor', 'E1006', 'ENG', 'EMPLOYEE', true, false, 'meera.iyer@acme.test'],
  ['asha.rao@acme.test', 'Asha Rao', 'E1001', 'ENG', 'EMPLOYEE', false, false, 'ravi.menon@acme.test'],
  ['arjun.das@acme.test', 'Arjun Das', 'E1007', 'ENG', 'EMPLOYEE', false, false, 'neha.kapoor@acme.test'],
  ['farah.khan@acme.test', 'Farah Khan', 'E1008', 'FIN', 'FINANCE', false, false, 'deepa.menon@acme.test'],
];
export const CATEGORIES = [
  ['TRAVEL_AIR', 'Air travel', '6101', true], ['TRAVEL_RAIL', 'Rail travel', '6102', true],
  ['LOCAL_TRANSPORT', 'Local transport', '6103', true], ['LODGING', 'Hotels & lodging', '6110', true],
  ['MEALS', 'Meals', '6120', true], ['CLIENT_ENTERTAINMENT', 'Client entertainment', '6130', true],
  ['OFFICE_SUPPLIES', 'Office supplies', '6200', true], ['INTERNET_PHONE', 'Internet & phone', '6210', true],
  ['TRAINING', 'Training & courses', '6300', true], ['MISC', 'Miscellaneous', '6900', true],
  ['LEGACY_PER_DIEM', 'Per diem (retired)', '6199', false],
];

/** Seeds reference data as the owner; returns { users: {short: id}, cats: {CODE: id} }. */
export async function seedReference(owner, { withTiers = true } = {}) {
  for (const [code, name] of [['ENG', 'Engineering'], ['FIN', 'Finance'], ['EXEC', 'Executive']]) {
    await owner.query('INSERT INTO departments (code, name) VALUES ($1, $2)', [code, name]);
  }
  const users = {};
  for (const [email, name, code, dept, role, canApprove, fallback, manager] of CAST) {
    const { rows } = await owner.query(
      `INSERT INTO users (employee_code, email, name, role, can_approve, is_fallback_approver, department_id, manager_id)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT id FROM departments WHERE code = $7), (SELECT id FROM users WHERE email = $8))
       RETURNING id`, [code, email, name, role, canApprove, fallback, dept, manager]);
    users[email.split('.')[0].replace('@acme', '')] = rows[0].id;
  }
  const cats = {};
  let i = 0;
  for (const [code, name, gl, active] of CATEGORIES) {
    const { rows } = await owner.query(
      'INSERT INTO categories (code, name, gl_code, is_active, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [code, name, gl, active, i++]);
    cats[code] = rows[0].id;
  }
  if (withTiers) {
    await owner.query(`
      INSERT INTO approval_policy_tiers (level, code, label, applies_above_minor, resolver, levels_up, designated_user_id, is_active) VALUES
        (1, 'L1_MANAGER',       'Line manager',       0,        'REPORTING_LINE', 1, NULL, true),
        (2, 'L2_SKIP_LEVEL',    'Skip-level manager', 1000000,  'REPORTING_LINE', 2, NULL, true),
        (3, 'L3_SENIOR_LEADER', 'Senior leader',      5000000,  'REPORTING_LINE', 3, NULL, true),
        (4, 'L4_CFO',           'CFO',                20000000, 'DESIGNATED_USER', NULL, $1, false)`, [users.deepa]);
  }
  return { users, cats };
}

export const reqId = () => `req-${randomUUID()}`;
export const todayIst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export async function createClaim(c, claimantId, title = 'Client visit Pune') {
  const { rows } = await c.query('INSERT INTO claims (claimant_id, title) VALUES ($1, $2) RETURNING *', [claimantId, title]);
  return rows[0];
}

/** lines: [{ amount, cat, date, description, merchant }] — one multi-row INSERT (like createMany). */
export async function addLines(c, claimId, cats, lines) {
  const vals = []; const params = [];
  lines.forEach((l, i) => {
    params.push(claimId, cats[l.cat ?? 'MEALS'], l.date ?? '2026-10-01', l.amount, l.description ?? `Line ${i + 1} expense`, l.merchant ?? null);
    const b = i * 6;
    vals.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
  });
  const { rows } = await c.query(
    `INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description, merchant) VALUES ${vals.join(', ')} RETURNING *`, params);
  return rows;
}

export async function claimRow(c, id) { return (await c.query('SELECT * FROM claims WHERE id = $1', [id])).rows[0]; }
export async function lineSum(c, id) {
  return Number((await c.query('SELECT COALESCE(SUM(amount_minor),0)::bigint AS s FROM line_items WHERE claim_id = $1', [id])).rows[0].s);
}
export async function drift(c) { return (await c.query('SELECT * FROM v_claim_total_drift')).rows; }

/** Snapshot JSON v1 (C-21), built from the live rows exactly as the service would. */
export async function buildSnapshot(c, claimId) {
  const { rows: [h] } = await c.query(
    `SELECT c.title, c.currency, c.total_minor, u.id AS uid, u.employee_code, u.name, u.email, d.code AS dept
       FROM claims c JOIN users u ON u.id = c.claimant_id JOIN departments d ON d.id = u.department_id WHERE c.id = $1`, [claimId]);
  const { rows: lines } = await c.query(
    `SELECT li.id, li.expense_date, li.category_id, cat.code, cat.name, cat.gl_code, li.amount_minor, li.description, li.merchant
       FROM line_items li JOIN categories cat ON cat.id = li.category_id WHERE li.claim_id = $1 ORDER BY li.expense_date, li.id`, [claimId]);
  let receipts = [];
  const { rows: [{ r: hasReceipts }] } = await c.query(`SELECT to_regclass('public.receipts') AS r`);
  if (hasReceipts) receipts = (await c.query(`SELECT * FROM receipts WHERE claim_id = $1 ORDER BY created_at, id`, [claimId])).rows;
  return {
    v: 1,
    claimant: { id: h.uid, employeeCode: h.employee_code, name: h.name, email: h.email, departmentCode: h.dept },
    title: h.title, currency: h.currency, totalMinor: h.total_minor,
    lines: lines.map((l) => ({
      lineItemId: l.id, expenseDate: l.expense_date, categoryId: l.category_id, categoryCode: l.code, categoryName: l.name,
      glCode: l.gl_code, amountMinor: l.amount_minor, description: l.description, merchant: l.merchant,
      receipts: receipts.filter((r) => r.line_item_id === l.id).map((r) => ({
        receiptId: r.id, fileName: r.file_name, contentType: r.content_type, sizeBytes: r.size_bytes, sha256: r.sha256, storageKey: r.storage_key,
      })),
    })),
  };
}

/** Pure-ish buildChain (D-20) over live tiers + org, enough to drive realistic submits. */
export async function buildChain(c, claimantId, totalMinor) {
  const { rows: tiers } = await c.query('SELECT * FROM approval_policy_tiers WHERE is_active AND applies_above_minor < $1 ORDER BY level', [totalMinor]);
  const { rows: us } = await c.query('SELECT * FROM users');
  const byId = new Map(us.map((u) => [u.id, u]));
  const fallback = us.find((u) => u.is_fallback_approver);
  const chain = [];
  const eligible = (u) => u && u.is_active && u.can_approve && u.role !== 'FINANCE' && u.id !== claimantId && !chain.some((s) => s.approverId === u.id);
  for (const t of tiers) {
    let primary = null;
    if (t.resolver === 'REPORTING_LINE') {
      primary = byId.get(claimantId);
      for (let i = 0; i < t.levels_up && primary; i++) primary = primary.manager_id ? byId.get(primary.manager_id) : null;
    } else primary = byId.get(t.designated_user_id);
    let pick = null; let via = null;
    if (eligible(primary)) { pick = primary; via = 'PRIMARY'; }
    else {
      let m = primary; let hops = 0;
      while (m && m.manager_id && hops++ < 25) { m = byId.get(m.manager_id); if (eligible(m)) { pick = m; via = 'ESCALATED'; break; } }
      if (!pick && eligible(fallback)) { pick = fallback; via = 'FALLBACK'; }
    }
    if (!pick) { const e = new Error(`ROUTING_UNRESOLVABLE ${t.code}`); e.routing = { tierCode: t.code, level: t.level }; throw e; }
    chain.push({ level: chain.length + 1, tierCode: t.code, tierLabel: t.label, appliesAboveMinor: t.applies_above_minor, approverId: pick.id, resolvedVia: via });
  }
  return chain;
}

export async function recordEvent(c, ev) {
  const { rows } = await c.query(
    `INSERT INTO claim_events (claim_id, submission_id, step_id, revision, type, actor_id, actor_role, from_status, to_status,
                               total_minor, reason, payload, request_id, occurred_at, tx_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14::timestamptz, now()), COALESCE($15::bigint, (pg_current_xact_id()::text)::bigint))
     RETURNING *`,
    [ev.claimId, ev.submissionId ?? null, ev.stepId ?? null, ev.revision, ev.type, ev.actorId, ev.actorRole, ev.from, ev.to,
      ev.totalMinor, ev.reason ?? null, JSON.stringify(ev.payload ?? {}), ev.requestId ?? reqId(), ev.occurredAt ?? null, ev.txId ?? null]);
  return rows[0];
}

/** Submit / resubmit (C-25). hooks: snapshot(s)->s, chain(ch)->ch, event(e)->e|null, beforeClaimUpdate(c, ctx). */
export async function submit(c, claimId, actorId, hooks = {}) {
  return tx(c, async () => {
    const { rows: [cl] } = await c.query('SELECT * FROM claims WHERE id = $1 AND claimant_id = $2 FOR NO KEY UPDATE', [claimId, actorId]);
    if (!cl) throw Object.assign(new Error('CLAIM_NOT_FOUND'), { app: 'CLAIM_NOT_FOUND' });
    const rev = cl.current_revision + 1;
    let chain = hooks.chain ? hooks.chain(await buildChain(c, cl.claimant_id, cl.total_minor).catch(() => [])) : await buildChain(c, cl.claimant_id, cl.total_minor);
    let snap = await buildSnapshot(c, claimId);
    if (hooks.snapshot) snap = hooks.snapshot(snap);
    const { rows: [sub] } = await c.query(
      `INSERT INTO claim_submissions (claim_id, revision, submitted_by_id, total_minor, currency, line_item_count, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [claimId, hooks.revision ?? rev, hooks.submittedBy ?? actorId, cl.total_minor, cl.currency, snap.lines.length, JSON.stringify(snap)]);
    const steps = [];
    for (const s of chain) {
      const { rows: [st] } = await c.query(
        `INSERT INTO approval_steps (claim_id, submission_id, level, tier_code, tier_label, applies_above_minor, approver_id, resolved_via, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [claimId, sub.id, s.level, s.tierCode, s.tierLabel, s.appliesAboveMinor, s.approverId, s.resolvedVia, s.status ?? (s.level === 1 ? 'PENDING' : 'WAITING')]);
      steps.push(st);
    }
    if (hooks.beforeClaimUpdate) await hooks.beforeClaimUpdate(c, { cl, sub, steps });
    await c.query(`UPDATE claims SET status = 'SUBMITTED', current_revision = $2, current_submission_id = $3 WHERE id = $1`, [claimId, rev, sub.id]);
    let ev = { claimId, submissionId: sub.id, revision: rev, type: cl.status === 'REJECTED' ? 'CLAIM_RESUBMITTED' : 'CLAIM_SUBMITTED',
      actorId, actorRole: 'CLAIMANT', from: cl.status, to: 'SUBMITTED', totalMinor: cl.total_minor,
      payload: { lineItemCount: snap.lines.length, chain: chain.map(({ level, tierCode, approverId, resolvedVia }) => ({ level, tierCode, approverId, resolvedVia })) } };
    if (hooks.event) ev = hooks.event(ev);
    if (ev) await recordEvent(c, ev);
    if (hooks.beforeCommit) await hooks.beforeCommit(c, { cl, sub, steps });
    return { submission: sub, steps };
  });
}

async function lockRoutedToMe(c, claimId, approverId) {
  const { rows: [cl] } = await c.query(
    `SELECT c.* FROM claims c WHERE c.id = $1 AND EXISTS (
       SELECT 1 FROM approval_steps s WHERE s.claim_id = c.id AND s.approver_id = $2 AND s.status = 'PENDING')
     FOR NO KEY UPDATE OF c`, [claimId, approverId]);
  if (!cl) throw Object.assign(new Error('NOT_IN_YOUR_QUEUE'), { app: 'NOT_IN_YOUR_QUEUE' });
  const { rows: [step] } = await c.query(
    `SELECT * FROM approval_steps WHERE submission_id = $1 AND approver_id = $2 AND status = 'PENDING'`, [cl.current_submission_id, approverId]);
  if (!step) throw Object.assign(new Error('NOT_IN_YOUR_QUEUE'), { app: 'NOT_IN_YOUR_QUEUE' });
  return { cl, step };
}

/** Approve (C-25). hooks: event(e)->e|null, stepPatch (extra SET sql), claimPatch. */
export async function approve(c, claimId, approverId, hooks = {}) {
  return tx(c, async () => {
    const { cl, step } = await lockRoutedToMe(c, claimId, approverId);
    const r = await c.query(`UPDATE approval_steps SET status = 'APPROVED', comment = $2 ${hooks.stepPatch ?? ''} WHERE id = $1 AND status = 'PENDING'`, [step.id, hooks.comment ?? null]);
    if (r.rowCount !== 1) throw new Error('CONFLICT');
    const { rows: [next] } = await c.query('SELECT * FROM approval_steps WHERE submission_id = $1 AND level = $2', [step.submission_id, step.level + 1]);
    let ev;
    const base = { claimId, submissionId: step.submission_id, stepId: step.id, revision: cl.current_revision, actorId: approverId,
      actorRole: 'APPROVER', totalMinor: cl.total_minor, reason: hooks.comment ?? null };
    if (next) {
      await c.query(`UPDATE approval_steps SET status = 'PENDING' WHERE id = $1 AND status = 'WAITING'`, [next.id]);
      ev = { ...base, type: 'STEP_APPROVED', from: 'SUBMITTED', to: 'SUBMITTED', payload: { level: step.level, nextApproverId: next.approver_id } };
    } else {
      await c.query(`UPDATE claims SET status = 'APPROVED' ${hooks.claimPatch ?? ''} WHERE id = $1`, [claimId]);
      ev = { ...base, type: 'CLAIM_APPROVED', from: 'SUBMITTED', to: 'APPROVED', payload: { level: step.level } };
    }
    if (hooks.event) ev = hooks.event(ev);
    if (ev) await recordEvent(c, ev);
    return { step, final: !next };
  });
}

export async function reject(c, claimId, approverId, reason = 'Hotel invoice missing for 3 Oct', hooks = {}) {
  return tx(c, async () => {
    const { cl, step } = await lockRoutedToMe(c, claimId, approverId);
    await c.query(`UPDATE approval_steps SET status = 'REJECTED', rejection_reason = $2 WHERE id = $1 AND status = 'PENDING'`, [step.id, reason]);
    if (!hooks.skipCancel) await c.query(`UPDATE approval_steps SET status = 'CANCELLED' WHERE submission_id = $1 AND status = 'WAITING'`, [step.submission_id]);
    await c.query(`UPDATE claims SET status = 'REJECTED' WHERE id = $1`, [claimId]);
    let ev = { claimId, submissionId: step.submission_id, stepId: step.id, revision: cl.current_revision, type: 'CLAIM_REJECTED',
      actorId: approverId, actorRole: 'APPROVER', from: 'SUBMITTED', to: 'REJECTED', totalMinor: cl.total_minor, reason, payload: { level: step.level } };
    if (hooks.event) ev = hooks.event(ev);
    if (ev) await recordEvent(c, ev);
  });
}

export async function recall(c, claimId, actorId, hooks = {}) {
  return tx(c, async () => {
    const { rows: [cl] } = await c.query('SELECT * FROM claims WHERE id = $1 AND claimant_id = $2 FOR NO KEY UPDATE', [claimId, actorId]);
    if (!cl) throw Object.assign(new Error('CLAIM_NOT_FOUND'), { app: 'CLAIM_NOT_FOUND' });
    if (!hooks.skipCancel) {
      await c.query(`UPDATE approval_steps SET status = 'CANCELLED' WHERE submission_id = $1 AND status IN ('PENDING', 'WAITING')`, [cl.current_submission_id]);
    }
    await c.query(`UPDATE claims SET status = 'DRAFT' WHERE id = $1`, [claimId]);
    let ev = { claimId, submissionId: cl.current_submission_id, revision: cl.current_revision, type: 'CLAIM_RECALLED', actorId,
      actorRole: 'CLAIMANT', from: 'SUBMITTED', to: 'DRAFT', totalMinor: cl.total_minor, payload: {} };
    if (hooks.event) ev = hooks.event(ev);
    if (ev) await recordEvent(c, ev);
  });
}

/** Approve every level in order until APPROVED. */
export async function approveAll(c, claimId) {
  for (;;) {
    const { rows: [p] } = await c.query(
      `SELECT s.approver_id FROM approval_steps s JOIN claims c ON c.current_submission_id = s.submission_id
        WHERE c.id = $1 AND s.status = 'PENDING'`, [claimId]);
    if (!p) return;
    await approve(c, claimId, p.approver_id);
  }
}

export async function addReceipt(c, claimId, lineItemId, uploaderId, i = 0) {
  const { rows: [r] } = await c.query(
    `INSERT INTO receipts (claim_id, line_item_id, storage_key, file_name, content_type, size_bytes, sha256, uploaded_by_id)
     VALUES ($1, $2, $3, $4, 'application/pdf', 1234, $5, $6) RETURNING *`,
    [claimId, lineItemId, `receipts/${claimId}/${lineItemId}/${randomUUID()}`, `invoice-${i}.pdf`, 'a'.repeat(63) + String(i % 10), uploaderId]);
  return r;
}
