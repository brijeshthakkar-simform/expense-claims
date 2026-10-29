import { readFile } from 'node:fs/promises';
import { addDaysYmd, todayInBusinessTz } from '@/shared/dates';
import {
  createAndSubmit,
  getClaim,
  isInPendingQueue,
  recallIfInApproval,
  uniqueTitle,
} from './support/api';
import { parseCsv } from './support/csv';
import { expect, test } from './support/fixtures';
import { PERSONAS } from './support/personas';
import { claimLink, queueRow, waitForList } from './support/ui';

const UUID = /\/claims\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// TC-E01 (05 §15.3): §2 submit, §3.2 two-level routing, §3.6 export, through the real image and a
// browser in Los Angeles. No receipt step, so this journey never depends on P6.
test('asha submits ₹25,000, ravi then meera approve, farah exports it', async ({ as }) => {
  test.slow(); // four personas and a download in one journey

  const asha = await as('asha');
  const ravi = await as('ravi');
  const meera = await as('meera');
  const farah = await as('farah');

  // An in-flight claim (approval pending with Ravi) that the export must leave out.
  const inFlight = await createAndSubmit(asha.api, uniqueTitle('in-flight'), [
    { category: 'MEALS', amountMinor: 800_000, description: 'Team lunch, in approval' },
  ]);
  const title = uniqueTitle('journey 1');

  try {
    // --- Asha (UI): two lines, the integer preview, Save draft, then Submit -----------------
    const a = asha.page;
    await a.goto('/claims/new');
    await a.getByLabel('Title', { exact: true }).fill(title);

    await a.getByLabel('Category for line 1', { exact: true }).selectOption('Hotels & lodging');
    await a.getByLabel('Description for line 1', { exact: true }).fill('Hotel, three nights');
    await a.getByLabel('Amount for line 1', { exact: true }).fill('20000');

    await a.getByRole('button', { name: 'Add line item' }).click();
    await a.getByLabel('Category for line 2', { exact: true }).selectOption('Meals');
    await a.getByLabel('Description for line 2', { exact: true }).fill('Client dinner');
    await a.getByLabel('Amount for line 2', { exact: true }).fill('5000');
    await a.getByLabel('Amount for line 2', { exact: true }).blur();

    await expect(a.getByTestId('unsaved-total')).toContainText('₹25,000.00');
    await a.getByRole('button', { name: 'Save draft' }).click();

    await expect(a).toHaveURL(UUID);
    const claimId = new URL(a.url()).pathname.split('/').pop()!;
    await expect(a.getByTestId('saved-total')).toHaveText('₹25,000.00');
    const claimNumber = (await a.getByTestId('claim-number').textContent())!.trim();
    expect(claimNumber).toMatch(/^EXP-\d{4}-\d{6}$/);

    await a.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(a.getByTestId('claim-status')).toHaveText('In approval · level 1 of 2');

    // --- Meera: level 2 is WAITING, so her queue doesn't list it yet ---------------------------
    await meera.page.goto('/approvals');
    await waitForList(meera.page);
    await expect(claimLink(meera.page, claimNumber)).toHaveCount(0);
    expect(await isInPendingQueue(meera.api, claimId)).toBe(false);

    // --- Ravi: queue → review → Approve; the dialog names Meera as next -------------------------
    const r = ravi.page;
    await r.goto('/approvals');
    await (await queueRow(r, claimNumber)).getByRole('link', { name: claimNumber }).click();
    await expect(r).toHaveURL(`/approvals/${claimId}`);
    await expect(r.getByRole('heading', { level: 1, name: title })).toBeVisible();

    await r.getByRole('button', { name: 'Approve', exact: true }).click();
    const raviDialog = r.getByRole('dialog');
    await expect(raviDialog).toContainText(`It will go to ${PERSONAS.meera.name} next.`);
    await raviDialog.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(r).toHaveURL(/\/approvals$/);
    await waitForList(r);
    await expect(claimLink(r, claimNumber)).toHaveCount(0);
    expect(await isInPendingQueue(ravi.api, claimId)).toBe(false);

    // --- Meera: now it is hers; her dialog says this is the final approval --------------------
    const m = meera.page;
    await m.goto('/approvals');
    await (await queueRow(m, claimNumber)).getByRole('link', { name: claimNumber }).click();
    await expect(m).toHaveURL(`/approvals/${claimId}`);
    await m.getByRole('button', { name: 'Approve', exact: true }).click();
    const meeraDialog = m.getByRole('dialog');
    await expect(meeraDialog).toContainText('final approval');
    await meeraDialog.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(m).toHaveURL(/\/approvals$/);

    // --- Asha: reload → Approved and locked; times read IST in a Los Angeles browser ------------
    await a.reload();
    await expect(a.getByTestId('claim-status')).toContainText('Approved');
    await expect(a.getByTestId('locked-banner')).toBeVisible();
    await expect(a.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
    expect(await a.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
      'America/Los_Angeles',
    );
    const events = a.getByTestId('timeline-event');
    await expect(events.last()).toHaveAttribute('data-event-type', 'CLAIM_APPROVED');
    await expect(events.first().locator('time')).toHaveText(/ IST$/);

    const approved = await getClaim(asha.api, claimId);
    expect(approved.status).toBe('APPROVED');
    expect(approved.totalMinor).toBe(2_500_000);

    // --- Farah: export yesterday → today (IST), so a run near IST midnight still matches ---------
    const today = todayInBusinessTz();
    const yesterday = addDaysYmd(today, -1);
    const f = farah.page;
    await f.goto('/finance/export');
    await f.getByLabel('From (IST)', { exact: true }).fill(yesterday);
    await f.getByLabel('To (IST)', { exact: true }).fill(today);
    const link = f.getByTestId('export-download');
    await expect(link).toHaveAttribute('href', new RegExp(`from=${yesterday}&to=${today}`));

    const [download] = await Promise.all([f.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe(`approved-claims_${yesterday}_${today}.csv`);
    const records = parseCsv(await readFile((await download.path())!, 'utf8'));

    const rows = records.filter((r) => r.claim_number === claimNumber);
    expect(rows, `${claimNumber} is exported, one row per line`).toHaveLength(2);
    for (const row of rows) {
      expect(row.claim_total).toBe('25000.00');
      expect(row.claim_title).toBe(title);
      expect(row.final_approver_email).toBe(PERSONAS.meera.email);
    }
    expect(rows.map((row) => row.amount).sort()).toEqual(['20000.00', '5000.00']);
    const exported = new Set(records.map((r) => r.claim_number));
    expect(exported.has(inFlight.claimNumber), 'the in-flight claim is not exported').toBe(false);
  } finally {
    await recallIfInApproval(asha.api, inFlight.id);
  }
});
