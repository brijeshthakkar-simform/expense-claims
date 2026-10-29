'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { CheckCheck, History, SearchX } from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { approvalsQuery } from '@/features/approvals/api';
import { queueColumns, type QueueTab } from '@/features/approvals/columns';
import { useUrlQuery } from '@/lib/use-url-query';
import { ApprovalQueueQuery, DECIDED_STATUSES } from '@/shared/schemas/queries';

const DECIDED_ALL = DECIDED_STATUSES.join(',');

// OPTIONAL Decided sub-filter (05 §10.3): just `status=APPROVED` / `status=REJECTED`.
const DECISION_OPTIONS = [
  { value: DECIDED_ALL, label: 'All my decisions' },
  { value: 'APPROVED', label: 'Approved by me' },
  { value: 'REJECTED', label: 'Rejected by me' },
] as const;

const COPY: Record<QueueTab, { range: string; caption: string }> = {
  pending: {
    range: 'Routed to me between',
    caption: 'Claims waiting for my decision, oldest routed first',
  },
  decided: { range: 'Decided between', caption: 'Claims I decided, newest first' },
};

/**
 * /approvals (05 §10.3): Pending (`status` absent or PENDING, oldest routed first: FIFO) and Decided
 * (`status=APPROVED,REJECTED`, newest first) tabs bound to the URL, plus an IST date range on the
 * tab's own date column. What is listed is decided by the server alone: WAITING steps and other
 * approvers' claims never arrive (TC-I25), the UI filters nothing.
 */
export function ApprovalsScreen() {
  const { value, params, set } = useUrlQuery(ApprovalQueueQuery);
  const tab: QueueTab = value.status.includes('PENDING') ? 'pending' : 'decided';
  // Normalised so `REJECTED,APPROVED` in a hand-typed URL still selects "All my decisions".
  const decisionFilter = value.status.length === 1 ? (value.status[0] ?? '') : DECIDED_ALL;
  const hasRange = Boolean(params.from || params.to);
  const isFiltered = hasRange || (tab === 'decided' && decisionFilter !== DECIDED_ALL);

  const switchTab = (next: string) => set({ status: next === 'decided' ? DECIDED_ALL : undefined }); // Pending = the default
  const clear = () =>
    set({ from: undefined, to: undefined, status: tab === 'decided' ? DECIDED_ALL : undefined });

  return (
    <Tabs value={tab} onValueChange={switchTab} className="gap-5">
      <TabsList aria-label="Approval queue">
        <TabsTrigger value="pending">Pending</TabsTrigger>
        <TabsTrigger value="decided">Decided</TabsTrigger>
      </TabsList>

      <FilterBar label="Filter approvals" isFiltered={isFiltered} onClear={clear}>
        {tab === 'decided' && (
          <SelectFilter
            label="Decision"
            value={decisionFilter}
            options={DECISION_OPTIONS}
            onChange={(status) => set({ status })}
          />
        )}
        <DateRangeFilter
          legend={COPY[tab].range}
          value={{ from: params.from, to: params.to }}
          onChange={(range) => set(range).ok}
        />
      </FilterBar>

      {/* One panel per tab (Radix wires aria-controls); only the active one mounts its list. */}
      <TabsContent value="pending">
        {tab === 'pending' && (
          <QueueList tab="pending" params={params} isFiltered={isFiltered} onClear={clear} />
        )}
      </TabsContent>
      <TabsContent value="decided">
        {tab === 'decided' && (
          <QueueList tab="decided" params={params} isFiltered={isFiltered} onClear={clear} />
        )}
      </TabsContent>
    </Tabs>
  );
}

function QueueList({
  tab,
  params,
  isFiltered,
  onClear,
}: {
  tab: QueueTab;
  params: Readonly<Record<string, string>>;
  isFiltered: boolean;
  onClear: () => void;
}) {
  const options = approvalsQuery(params);
  const query = useInfiniteQuery(options);
  return (
    <PagedTable
      query={query}
      queryKey={options.queryKey}
      columns={queueColumns(tab)}
      rowKey={(t) => t.stepId}
      caption={COPY[tab].caption}
      isFiltered={isFiltered}
      forbiddenArea="Approvals"
      data-testid={`approvals-${tab}-table`}
      empty={
        tab === 'pending' ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CheckCheck aria-hidden />
              </EmptyMedia>
              <EmptyTitle>You&apos;re all caught up.</EmptyTitle>
              <EmptyDescription>
                Claims routed to you for a decision appear here, oldest first.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No decisions yet</EmptyTitle>
              <EmptyDescription>
                Claims you approve or reject appear here, newest first.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      }
      filteredEmpty={
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX aria-hidden />
            </EmptyMedia>
            <EmptyTitle>
              {tab === 'pending'
                ? 'No claims were routed to you between these dates'
                : 'No decisions match these filters'}
            </EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" variant="outline" onClick={onClear}>
              Clear filters
            </Button>
          </EmptyContent>
        </Empty>
      }
    />
  );
}
