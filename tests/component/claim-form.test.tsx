// TC-C01 (§3.1-c, §6-1): the presentational ClaimForm (05 §6.3, §15.2) with props in and callbacks
// out, so no network mocks. The UI never sends a total (the DB derives it), amounts leave as
// integer paise, server field issues land on their field, and edits keep the server's line ids.
// The browser runs in America/Los_Angeles (vitest.config.mts) while "today" is an IST day.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimForm } from '@/features/claims/claim-form';
import { ApiError } from '@/lib/api-client';
import type { CategoryDto } from '@/shared/dto/categories';
import type { ClaimDetail } from '@/shared/dto/claims';
import type { ReplaceClaimInput } from '@/shared/schemas/claims';

const category = (id: string, code: string, name: string): CategoryDto => ({
  id,
  code,
  name,
  isActive: true,
});
const cats = [
  category('3f0b5a52-8a8e-4c71-9a0e-6d2f4b1c7e01', 'LODGING', 'Hotels & lodging'),
  category('3f0b5a52-8a8e-4c71-9a0e-6d2f4b1c7e02', 'MEALS', 'Meals'),
];
const LINE_1 = '9b1e2c3d-4f5a-4b6c-8d7e-0f1a2b3c4d01';
const LINE_2 = '9b1e2c3d-4f5a-4b6c-8d7e-0f1a2b3c4d02';

/** A ClaimDetail as the API returns it (two lines: ₹4,500.50 lodging + ₹350.00 meals). */
const detailFixture = (o: Partial<ClaimDetail> = {}): ClaimDetail => ({
  id: '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f',
  claimNumber: 'EXP-2026-000042',
  title: 'Client visit, Pune',
  status: 'DRAFT',
  currency: 'INR',
  totalMinor: 485_050,
  currentRevision: 0,
  claimant: { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'Asha Rao' },
  createdAt: '2026-10-10T04:30:00.000Z',
  submittedAt: null,
  approvedAt: null,
  rejectedAt: null,
  lineItems: [
    {
      id: LINE_1,
      expenseDate: '2026-10-05',
      category: cats[0]!,
      amountMinor: 450_050,
      description: 'Hotel, 2 nights',
      merchant: 'Taj',
      receipts: [],
    },
    {
      id: LINE_2,
      expenseDate: '2026-10-06',
      category: cats[1]!,
      amountMinor: 35_000,
      description: 'Team dinner',
      merchant: null,
      receipts: [],
    },
  ],
  approval: null,
  lastRejection: null,
  allowedActions: ['EDIT', 'SUBMIT', 'DELETE'],
  ...o,
});

/** The first payload handed to onSave. */
const payloadOf = (onSave: ReturnType<typeof vi.fn>) =>
  onSave.mock.calls[0]![0] as ReplaceClaimInput;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); // only the clock: user-event still gets real timers
  vi.setSystemTime(new Date('2026-10-12T06:00:00Z')); // 11 Oct 23:00 in LA, 12 Oct 11:30 in IST
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TC-C01 ClaimForm', () => {
  it('preview total shows ₹0.30 for 0.10 + 0.20', async () => {
    expect(new Date().getTimezoneOffset()).toBe(420); // the browser really is in LA (PDT)
    const user = userEvent.setup();
    render(<ClaimForm categories={cats} onSave={vi.fn()} />);
    await user.type(screen.getByLabelText('Amount for line 1'), '0.10');
    await user.click(screen.getByRole('button', { name: 'Add line item' }));
    await user.type(screen.getByLabelText('Amount for line 2'), '0.20');
    expect(screen.getByTestId('unsaved-total')).toHaveTextContent('₹0.30'); // integer paise: 10 + 20
    expect(screen.getByTestId('unsaved-total')).not.toHaveTextContent('0.30000000000000004');
  });

  it('submits amountMinor integers and never a total', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(detailFixture());
    render(<ClaimForm categories={cats} onSave={onSave} />);
    // A new line defaults to today in IST (12 Oct), not the LA date (11 Oct)
    expect(screen.getByLabelText('Date for line 1')).toHaveValue('2026-10-12');

    await user.type(screen.getByLabelText('Title'), 'Client visit, Pune');
    fireEvent.change(screen.getByLabelText('Date for line 1'), {
      target: { value: '2026-10-05' },
    }); // typing into type=date is unreliable in jsdom
    const category1 = screen.getByLabelText('Category for line 1');
    // by the visible label (user-event's string match compares innerHTML, where & is &amp;)
    await user.selectOptions(
      category1,
      within(category1).getByRole('option', { name: 'Hotels & lodging' }),
    );
    await user.type(screen.getByLabelText('Description for line 1'), 'Hotel, 2 nights');
    await user.type(screen.getByLabelText('Amount for line 1'), '4,500.50');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = payloadOf(onSave);
    expect(Object.keys(payload).sort()).toEqual(['lineItems', 'title']);
    expect(payload.lineItems).toHaveLength(1);
    expect(payload.lineItems[0]).toEqual({
      expenseDate: '2026-10-05',
      categoryId: cats[0]!.id,
      description: 'Hotel, 2 nights',
      amountMinor: 450_050, // "4,500.50" → integer paise
    });
    expect(Number.isSafeInteger(payload.lineItems[0]!.amountMinor)).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/total/i); // the DB derives the total
  });

  it('server VALIDATION_FAILED issues land on the right field', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(
      new ApiError(
        422,
        'VALIDATION_FAILED',
        'Some fields need attention',
        {
          issues: [
            {
              path: ['lineItems', 1, 'categoryId'],
              code: 'CATEGORY_INACTIVE',
              message: 'This category is no longer available',
            },
          ],
        },
        'req-12345678',
      ),
    );
    render(<ClaimForm claim={detailFixture()} categories={cats} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const line2 = screen.getByLabelText('Category for line 2');
    await waitFor(() => expect(line2).toHaveAttribute('aria-invalid', 'true'));
    expect(line2).toHaveAccessibleDescription('This category is no longer available');
    expect(line2).toHaveFocus(); // the first server issue takes focus
    expect(
      within(screen.getByRole('listitem', { name: 'Line 2' })).getByText(
        'This category is no longer available',
      ),
    ).toBeInTheDocument();
    // ... and only there: line 1 and the title are untouched
    expect(screen.getByLabelText('Category for line 1')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Title')).not.toHaveAttribute('aria-invalid');
  });

  it('keeps server ids as lineItemId so edits are updates, not delete+insert', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(detailFixture());
    render(<ClaimForm claim={detailFixture()} categories={cats} onSave={onSave} />);
    const amount1 = screen.getByLabelText('Amount for line 1');
    expect(amount1).toHaveValue('4500.50');
    await user.clear(amount1);
    await user.type(amount1, '999.99');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = payloadOf(onSave);
    expect(payload.lineItems.map((l) => l.id)).toEqual([LINE_1, LINE_2]); // same ids, same order
    expect(payload.lineItems[0]).toEqual({
      id: LINE_1,
      expenseDate: '2026-10-05',
      categoryId: cats[0]!.id,
      description: 'Hotel, 2 nights',
      merchant: 'Taj',
      amountMinor: 99_999,
    });
    expect(payload.lineItems[1]).toEqual({
      id: LINE_2,
      expenseDate: '2026-10-06',
      categoryId: cats[1]!.id,
      description: 'Team dinner',
      amountMinor: 35_000, // untouched line: unchanged, still an update by id
    });
    expect(JSON.stringify(payload)).not.toContain('lineItemId'); // the form-only key never leaves
  });

  it('renders read-only when allowedActions lacks EDIT', () => {
    const submitted = detailFixture({
      status: 'SUBMITTED',
      currentRevision: 1,
      allowedActions: ['RECALL'],
    });
    const onSave = vi.fn();
    const { unmount } = render(<ClaimForm claim={submitted} categories={cats} onSave={onSave} />);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Add line item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove line/i })).not.toBeInTheDocument();
    // the lines are still shown, as a table, with the DB's total
    const table = screen.getByRole('table', { name: 'Line items' });
    expect(within(table).getByText('Hotel, 2 nights')).toBeInTheDocument();
    expect(within(table).getByText('Team dinner')).toBeInTheDocument();
    expect(screen.getByTestId('saved-total')).toHaveTextContent('₹4,850.50');
    expect(onSave).not.toHaveBeenCalled();
    unmount();

    // an APPROVED claim (allowedActions []) is read-only too, and offers no Submit either
    render(
      <ClaimForm
        claim={detailFixture({ status: 'APPROVED', currentRevision: 1, allowedActions: [] })}
        categories={cats}
        onSave={onSave}
        onSubmitClaim={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });
});
