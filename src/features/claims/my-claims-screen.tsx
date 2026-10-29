'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { FilePlus2, SearchX } from 'lucide-react';
import Link from 'next/link';
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
import { myClaimsQuery } from '@/features/claims/api';
import { myClaimsColumns } from '@/features/claims/columns';
import { useUrlQuery } from '@/lib/use-url-query';
import { ClaimListQuery } from '@/shared/schemas/queries';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'In approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
] as const;

/**
 * /claims (05 §4.2): my claims, newest first. Filters (status, created date in IST) live in the URL
 * and are parsed by the API's own ClaimListQuery; the server filters and pages.
 */
export function MyClaimsScreen() {
  const { params, set } = useUrlQuery(ClaimListQuery);
  const options = myClaimsQuery(params);
  const query = useInfiniteQuery(options);
  const isFiltered = Object.keys(params).length > 0;
  const clear = () => set({ status: undefined, from: undefined, to: undefined });

  return (
    <div className="flex flex-col gap-5">
      <FilterBar label="Filter my claims" isFiltered={isFiltered} onClear={clear}>
        <SelectFilter
          label="Status"
          value={params.status ?? ''}
          options={STATUS_OPTIONS}
          onChange={(status) => set({ status })}
        />
        <DateRangeFilter
          legend="Created date"
          value={{ from: params.from, to: params.to }}
          onChange={(range) => set(range).ok}
        />
      </FilterBar>

      <PagedTable
        query={query}
        queryKey={options.queryKey}
        columns={myClaimsColumns}
        rowKey={(c) => c.id}
        caption="My claims, newest first"
        isFiltered={isFiltered}
        data-testid="my-claims-table"
        empty={
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FilePlus2 aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No claims yet</EmptyTitle>
              <EmptyDescription>Claims you create appear here, newest first.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <Link href="/claims/new">Create your first claim</Link>
              </Button>
            </EmptyContent>
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
