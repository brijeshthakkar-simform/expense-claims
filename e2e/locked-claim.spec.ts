import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { approve, createDraft, expectError, getClaim, submit, uniqueTitle } from './support/api';
import { expect, test } from './support/fixtures';

const RECEIPT = fileURLToPath(new URL('./fixtures/receipt.pdf', import.meta.url));

// TC-E05 (05 §15.3): §3.4-a approved = read-only in the UI and the API, and §3.1-b's receipt step.
// The UI hides the editor because allowedActions lacks EDIT; the API still refuses on its own.
test('an approved claim renders read-only and a direct PUT returns 409 CLAIM_LOCKED', async ({
  as,
}) => {
  test.slow();
  const asha = await as('asha');
  const ravi = await as('ravi');

  // ₹3,000 routes to Ravi alone (T1).
  const title = uniqueTitle('locked claim');
  const draft = await createDraft(asha.api, title, [
    { category: 'LODGING', amountMinor: 300_000, description: 'Hotel, one night in Nashik' },
  ]);

  // --- Asha (UI): attach the receipt to line 1 of her draft ------------------------------------
  const a = asha.page;
  await a.goto(`/claims/${draft.id}`);
  await a.getByLabel('Attach receipt to line 1', { exact: true }).setInputFiles(RECEIPT);
  const receipts = a.getByRole('list', { name: 'Receipts for line 1' });
  await expect(receipts.getByTestId('receipt')).toHaveCount(1);
  await expect(receipts).toContainText('receipt.pdf');

  // --- Submit (Asha) and the final approval (Ravi) through the API -----------------------------
  const submitted = await submit(asha.api, draft.id);
  expect(submitted.currentRevision).toBe(1);
  await approve(ravi.api, draft.id, 1);
  const approved = await getClaim(asha.api, draft.id);
  expect(approved.status).toBe('APPROVED');
  const line = approved.lineItems[0]!;
  const receipt = line.receipts[0]!;
  expect(receipt.fileName).toBe('receipt.pdf');

  // --- UI: locked banner; no textbox, no Attach / Remove / Save; the receipt still downloads ---
  await a.reload();
  await expect(a.getByTestId('locked-banner')).toBeVisible();
  await expect(a.getByTestId('claim-status')).toContainText('Approved');
  const contents = a.getByRole('region', { name: 'Claim contents' });
  await expect(contents.getByRole('table', { name: 'Line items' })).toBeVisible();
  await expect(a.getByRole('textbox')).toHaveCount(0);
  await expect(a.getByRole('combobox')).toHaveCount(0);
  await expect(a.getByLabel(/^Attach receipt/)).toHaveCount(0);
  await expect(a.getByRole('button', { name: /^Remove/ })).toHaveCount(0);
  for (const name of ['Save draft', 'Submit', 'Add line item', 'Recall', 'Delete draft']) {
    await expect(a.getByRole('button', { name, exact: true }), name).toHaveCount(0);
  }

  const [download] = await Promise.all([
    a.waitForEvent('download'),
    contents.getByRole('link', { name: /receipt\.pdf/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('receipt.pdf');
  const bytes = await readFile((await download.path())!);
  expect(bytes.equals(await readFile(RECEIPT)), 'the stored receipt comes back unchanged').toBe(
    true,
  );

  // --- API: the server refuses on its own, whatever the UI shows ------------------------------
  await expectError(
    await asha.api.put(`/api/v1/claims/${draft.id}`, {
      data: {
        title: `${title} (edited)`,
        lineItems: [
          {
            id: line.id,
            expenseDate: line.expenseDate,
            categoryId: line.category.id,
            amountMinor: 1,
            description: line.description,
          },
        ],
      },
    }),
    409,
    'CLAIM_LOCKED',
  );
  await expectError(
    await asha.api.delete(`/api/v1/claims/${draft.id}/receipts/${receipt.id}`),
    409,
    'CLAIM_LOCKED',
  );
  const after = await getClaim(asha.api, draft.id);
  expect(after).toMatchObject({ title, totalMinor: 300_000, status: 'APPROVED' });
  expect(after.lineItems[0]?.receipts).toHaveLength(1);
});
