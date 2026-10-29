import { randomUUID } from 'node:crypto';
import type { Response } from '@playwright/test';
import {
  createAndSubmit,
  expectError,
  expectStatus,
  recallIfInApproval,
  uniqueTitle,
} from './support/api';
import { expect, test } from './support/fixtures';

// TC-E02 (05 §15.3), the browser half of the sharpest test (§6-4, TC-I17): Neha is an approver,
// but not on Asha's chain. The visibility predicate is inside the SELECT, so the API answers 404
// CLAIM_NOT_FOUND, and the page shows the same "Claim not found" words as for a random id (F9).
test("neha opening asha's claim sees the not-found view and the API returns 404", async ({
  as,
}) => {
  const asha = await as('asha');
  const neha = await as('neha');
  const ravi = await as('ravi');

  // ₹8,000 routes to Ravi alone (T1), never to Neha.
  const title = uniqueTitle('foreign claim');
  const claim = await createAndSubmit(asha.api, title, [
    { category: 'LOCAL_TRANSPORT', amountMinor: 800_000, description: 'Airport cabs for the week' },
  ]);

  try {
    // Positive control: the routed approver does see it, so a 404 below isn't a broken claim.
    await expectStatus(await ravi.api.get(`/api/v1/claims/${claim.id}`), 200);

    const page = neha.page;
    const isClaimGet = (res: Response) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === `/api/v1/claims/${claim.id}`;

    for (const path of [`/claims/${claim.id}`, `/approvals/${claim.id}`]) {
      const apiResponse = page.waitForResponse(isClaimGet);
      await page.goto(path);
      const res = await apiResponse;
      expect(res.status(), `${path}: the page's own GET`).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'CLAIM_NOT_FOUND',
      );

      await expect(page.getByRole('heading', { name: 'Claim not found' })).toBeVisible();
      // Nothing of the claim reaches the DOM: not its title, not its number.
      const html = await page.content();
      expect(html, `${path} leaks the title`).not.toContain(title);
      expect(html, `${path} leaks the claim number`).not.toContain(claim.claimNumber);
    }

    // The same 404 as a claim that doesn't exist: no existence oracle.
    await expectError(await neha.api.get(`/api/v1/claims/${claim.id}`), 404, 'CLAIM_NOT_FOUND');
    await expectError(await neha.api.get(`/api/v1/claims/${randomUUID()}`), 404, 'CLAIM_NOT_FOUND');

    // Deciding needs a PENDING step of hers on it: 403, and nothing changes.
    await expectError(
      await neha.api.post(`/api/v1/claims/${claim.id}/approve`, { data: { revision: 1 } }),
      403,
      'NOT_IN_YOUR_QUEUE',
    );
  } finally {
    await recallIfInApproval(asha.api, claim.id);
  }
});
