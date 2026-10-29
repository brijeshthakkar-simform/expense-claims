import { createAndSubmit, getClaim, recallIfInApproval, uniqueTitle } from './support/api';
import { expect, test } from './support/fixtures';
import { PERSONAS } from './support/personas';
import { queueRow } from './support/ui';

const REASON = 'Hotel invoice missing for 3 Oct';

// TC-E03 (05 §15.3), §3.3: a rejected claim comes back with its reason, is edited and resubmitted
// as revision 2, and the history keeps both revisions and the reason.
test('ravi rejects with a reason, asha edits and resubmits, and the timeline shows both revisions', async ({
  as,
}) => {
  test.slow();
  const asha = await as('asha');
  const ravi = await as('ravi');

  // ₹4,500 routes to Ravi alone (T1).
  const title = uniqueTitle('reject and resubmit');
  const claim = await createAndSubmit(asha.api, title, [
    { category: 'LODGING', amountMinor: 450_000, description: 'Hotel, one night in Pune' },
  ]);

  try {
    // --- Ravi: the reason is required (10+ characters), then he rejects -----------------------
    const r = ravi.page;
    await r.goto('/approvals');
    await (
      await queueRow(r, claim.claimNumber)
    )
      .getByRole('link', { name: claim.claimNumber })
      .click();
    await expect(r).toHaveURL(`/approvals/${claim.id}`);
    await r.getByRole('button', { name: 'Reject', exact: true }).click();

    const dialog = r.getByRole('dialog');
    const reason = dialog.getByLabel('Reason for rejecting');
    const confirm = dialog.getByRole('button', { name: 'Reject claim' });
    await reason.focus();
    await reason.blur(); // touched and still empty
    await expect(dialog.getByText('Reason must be at least 10 characters')).toBeVisible();
    await expect(confirm).toBeDisabled();

    await reason.fill(REASON);
    await expect(dialog.getByText('Reason must be at least 10 characters')).toHaveCount(0);
    await confirm.click();
    await expect(r).toHaveURL(/\/approvals$/);

    // --- Asha: the banner shows the reason, who and when (IST); she edits and resubmits --------
    const a = asha.page;
    await a.goto(`/claims/${claim.id}`);
    const banner = a.getByTestId('rejection-banner');
    await expect(banner).toContainText(REASON);
    await expect(banner).toContainText(PERSONAS.ravi.name);
    await expect(banner.locator('time')).toHaveText(/ IST$/);
    await expect(a.getByTestId('claim-status')).toHaveText('Rejected');

    const amount = a.getByLabel('Amount for line 1', { exact: true });
    await amount.fill('4200');
    await amount.blur();
    await expect(a.getByTestId('unsaved-total')).toContainText('₹4,200.00');
    await a.getByRole('button', { name: 'Save & resubmit' }).click();

    await expect(a.getByTestId('claim-status')).toHaveText('In approval · level 1 of 1');
    await expect(a.getByTestId('saved-total')).toHaveText('₹4,200.00');

    // The history: revision 1 rejected, revision 2 in approval, events in order, reason kept.
    const events = a.getByTestId('timeline-event');
    await expect
      .poll(() => events.evaluateAll((els) => els.map((e) => e.getAttribute('data-event-type'))))
      .toEqual(['CLAIM_SUBMITTED', 'CLAIM_REJECTED', 'CLAIM_RESUBMITTED']);
    await expect(events.nth(1)).toContainText(REASON);
    await expect(events.nth(1)).toContainText(PERSONAS.ravi.name);

    const revisions = a.getByTestId('revision-group');
    await expect(revisions).toHaveCount(2);
    await expect(revisions.nth(0)).toHaveAttribute('data-revision', '1');
    await expect(revisions.nth(0).getByTestId('revision-outcome')).toHaveText('Rejected');
    await expect(revisions.nth(1)).toHaveAttribute('data-revision', '2');
    await expect(revisions.nth(1).getByTestId('revision-outcome')).toHaveText('In approval');

    const resubmitted = await getClaim(asha.api, claim.id);
    expect(resubmitted).toMatchObject({
      status: 'SUBMITTED',
      currentRevision: 2,
      totalMinor: 420_000,
    });

    // --- Ravi: the Pending tab flags it as a resubmission ---------------------------------------
    await r.goto('/approvals');
    await expect(await queueRow(r, claim.claimNumber)).toContainText('Resubmitted (rev 2)');
  } finally {
    await recallIfInApproval(asha.api, claim.id);
  }
});
