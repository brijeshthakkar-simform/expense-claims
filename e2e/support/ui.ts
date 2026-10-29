import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Waits until a PagedTable list has loaded: it shows its row count ("Showing 3 claims"), or an
 * empty state. The skeleton shows neither, so a "not listed" assertion can't pass too early.
 */
export async function waitForList(page: Page): Promise<void> {
  await expect(
    page
      .getByText(/^Showing \d+ claims?/)
      .or(page.getByText("You're all caught up."))
      .or(page.getByText('No decisions yet')),
  ).toBeVisible();
}

/**
 * The /approvals row for a claim number, loading more pages until it shows up (the Pending tab
 * is oldest-first, and reruns only ever add claims). Fails if the list ends without it.
 */
export async function queueRow(page: Page, claimNumber: string): Promise<Locator> {
  await waitForList(page);
  const link = page.getByRole('link', { name: claimNumber, exact: true });
  const more = page.getByRole('button', { name: 'Load more' });
  const count = page.getByText(/^Showing \d+ claims?/);
  while ((await link.count()) === 0 && (await more.count()) > 0) {
    const before = await count.textContent();
    await more.click();
    await expect(count).not.toHaveText(before ?? '');
  }
  await expect(link, `${claimNumber} is listed`).toBeVisible();
  return page.getByRole('row').filter({ has: link });
}

/** The unique text a claim's row link carries in a queue. */
export const claimLink = (page: Page, claimNumber: string): Locator =>
  page.getByRole('link', { name: claimNumber, exact: true });
