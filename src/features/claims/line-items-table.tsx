import { CalendarDate, Money } from '@/components/common/formatting';
import { ReceiptList, type ReceiptFile } from '@/features/claims/receipts/receipt-list';
import type { ClaimDetail } from '@/shared/dto/claims';

type LiveLine = ClaimDetail['lineItems'][number];

/** What the table shows: a live line, or a submission snapshot's line (history). */
export type LineRow = Pick<
  LiveLine,
  'id' | 'expenseDate' | 'amountMinor' | 'description' | 'merchant'
> & {
  category: { name: string; isActive?: boolean };
  receipts?: readonly ReceiptFile[];
};

/**
 * Read-only lines (05 §6.3): a plain table with no inputs. Rendered when allowedActions lacks
 * EDIT; the history reuses it for each revision's snapshot lines (05 §9.3). Given `claimId`, a
 * Receipts column lists each line's receipts as download links (the snapshot's ones included:
 * the content route serves receipts an earlier revision referenced, 05 §8).
 */
export function LineItemsTable({
  lines,
  caption,
  claimId,
}: {
  lines: readonly LineRow[];
  caption?: string;
  claimId?: string;
}) {
  const showReceipts = claimId !== undefined;
  if (lines.length === 0) {
    return <p className="text-muted-foreground py-4 text-sm">No line items.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-muted/50 text-left">
          <tr>
            <th scope="col" className="w-10 px-3 py-2 font-medium">
              #
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Date
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Category
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Description
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Merchant
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Amount (₹)
            </th>
            {showReceipts && (
              <th scope="col" className="px-3 py-2 font-medium">
                Receipts
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {lines.map((li, i) => (
            <tr key={li.id} className="border-t align-top">
              <td className="text-muted-foreground px-3 py-2 tabular-nums">{i + 1}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                <CalendarDate ymd={li.expenseDate} />
              </td>
              <td className="px-3 py-2">
                {li.category.name}
                {li.category.isActive === false && (
                  <span className="text-muted-foreground"> (retired)</span>
                )}
              </td>
              <td className="px-3 py-2 break-words">{li.description}</td>
              <td className="px-3 py-2">{li.merchant ?? '—'}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <Money minor={li.amountMinor} />
              </td>
              {showReceipts && (
                <td className="min-w-48 px-3 py-1.5">
                  {li.receipts?.length ? (
                    <ReceiptList claimId={claimId} receipts={li.receipts} lineNumber={i + 1} />
                  ) : (
                    <span className="text-muted-foreground inline-block py-0.5">
                      <span aria-hidden>—</span>
                      <span className="sr-only">No receipts</span>
                    </span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
