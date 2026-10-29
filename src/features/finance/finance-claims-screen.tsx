'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Inbox, SearchX } from 'lucide-react';
import { DateRangeFilter, FilterBar, SelectFilter } from '@/components/lists/filter-bar';
import { PagedTable } from '@/components/lists/paged-table';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { financeClaimsQuery } from '@/features/finance/api';
import { financeColumns } from '@/features/finance/columns';
import { useUrlQuery } from '@/lib/use-url-query';
import { FINANCE_DEFAULT_STATUSES, FinanceClaimsQuery } from '@/shared/schemas/queries';

/** Each menu entry with the statuses it stands for; `''` is the API default (DRAFT hidden). */
const STATUS_MENU = [
  { value: '', label: 'Submitted, approved, rejected', statuses: FINANCE_DEFAULT_STATUSES },
  { value: 'SUBMITTED', label: 'In approval', statuses: ['SUBMITTED'] },
  { value: 'APPROVED', label: 'Approved', statuses: ['APPROVED'] },
  { value: 'REJECTED', label: 'Rejected', statuses: ['REJECTED'] },
  { value: 'DRAFT', label: 'Drafts', statuses: ['DRAFT'] },
  {
    value: 'DRAFT,SUBMITTED,APPROVED,REJECTED',
    label: 'Everything incl. drafts',
    statuses: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
  },
] as const;
const STATUS_OPTIONS = STATUS_MENU.map(({ value, label }) => ({ value, label }));

const DATE_FIELD_OPTIONS = [
  { value: 'submittedAt', label: 'Submitted date' },
  { value: 'approvedAt', label: 'Approved date' },
] as const;

const setKey = (values: readonly string[]) => [...values].sort().join(',');

/**
 * /finance/claims (05 §11): every employee's claims, read-only. Status, date field and an IST
 * from/to range live in the URL and are parsed by the API's own FinanceClaimsQuery; the server
 * filters, sorts (`<dateField> DESC, id DESC`) and pages. Nothing here is finance-specific beyond
 * the column config: it is the shared PagedTable + FilterBar.
 */
export function FinanceClaimsScreen() {
  const { value, params, set } = useUrlQuery(FinanceClaimsQuery);
  const options = financeClaimsQuery(params);
  const query = useInfiniteQuery(options);

  // Normalised, so `status=REJECTED,APPROVED,SUBMITTED` in a hand-typed URL still shows the default.
  const current = setKey(value.status);
  const statusFilter =
    STATUS_MENU.find((o) => setKey(o.statuses) === current)?.value ?? params.status ?? '';
  const byApproval = value.dateField === 'approvedAt';
  const isFiltered = Object.keys(params).length > 0;
  const clear = () =>
    set({ status: undefined, dateField: undefined, from: undefined, to: undefined });

  return (
    <div className="flex flex-col gap-5">
      <FilterBar label="Filter finance claims" isFiltered={isFiltered} onClear={clear}>
        <SelectFilter
          label="Status"
          value={statusFilter}
          options={STATUS_OPTIONS}
          onChange={(status) => set({ status })}
        />
        <SelectFilter
          label="Date field"
          value={value.dateField}
          options={DATE_FIELD_OPTIONS}
          // Submitted date is the API default: keep the URL clean.
          onChange={(dateField) =>
            set({ dateField: dateField === 'submittedAt' ? undefined : dateField })
          }
        />
        <DateRangeFilter
          legend={byApproval ? 'Approved between' : 'Submitted between'}
          value={{ from: params.from, to: params.to }}
          onChange={(range) => set(range).ok}
        />
      </FilterBar>

      <p className="text-muted-foreground text-sm">
        {byApproval
          ? 'Newest approval first. Only claims with a final approval have an approved date.'
          : 'Newest submission first.'}
      </p>

      <PagedTable
        query={query}
        queryKey={options.queryKey}
        columns={financeColumns}
        rowKey={(c) => c.id}
        caption={`All employees’ claims, newest ${byApproval ? 'approved' : 'submitted'} first`}
        isFiltered={isFiltered}
        forbiddenArea="Finance"
        data-testid="finance-claims-table"
        empty={
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No submitted claims yet</EmptyTitle>
              <EmptyDescription>
                Claims appear here once employees submit them, newest first.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
        filteredEmpty={
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchX aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No claims match these filters</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" variant="outline" onClick={clear}>
                Clear filters
              </Button>
            </EmptyContent>
          </Empty>
        }
      />
    </div>
  );
}
