import type { Metadata } from 'next';
import { ExportForm } from '@/features/finance/export-form';
import { todayInBusinessTz } from '@/shared/dates';

export const metadata: Metadata = { title: 'Export approved claims' };

/**
 * Thin page (05 §11): the period picker and the native CSV download. "Today" is the IST date at
 * request time (the (app) layout makes every page dynamic), passed down so the presets and the
 * period-open hint don't depend on the browser's timezone or differ between server and client.
 */
export default function FinanceExportPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Export approved claims</h1>
        <p className="text-muted-foreground text-sm">
          A CSV of finally approved claims for bookkeeping, one row per line item.
        </p>
      </div>
      <ExportForm today={todayInBusinessTz()} />
    </div>
  );
}
