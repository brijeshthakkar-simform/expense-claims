'use client';

import { useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ErrorReference } from '@/components/common/error-reference';
import { ForbiddenView } from '@/components/common/forbidden-view';
import { QueryErrorView } from '@/components/common/query-error-view';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, describeApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * The one list component (05 §10.2), reused by /claims, /approvals and /finance/claims: a real
 * <table> over a cursor-paged infinite query, with four states (loading skeleton, empty,
 * filtered-empty, error with Retry + reference) and "Load more". There is no total count by design:
 * the API runs no COUNT(*). Filtering and ordering are the server's; this never sorts or filters.
 */

export interface Column<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** `end` right-aligns with tabular numbers (amounts). */
  align?: 'start' | 'end';
  /** The row's name for assistive tech (claim number): rendered as <th scope="row">. */
  rowHeader?: boolean;
  className?: string;
}

/** The C-08 list envelope as the query returns it. */
export interface ListPage<T> {
  data: T[];
  page: { nextCursor: string | null };
}

/** The slice of a `useInfiniteQuery` result this table reads (structural, so any T fits). */
export interface PagedQuery<T> {
  data: InfiniteData<ListPage<T>, unknown> | undefined;
  error: unknown;
  isError: boolean;
  isFetchNextPageError: boolean;
  isRefetchError: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<{ error: unknown }>;
  refetch: () => Promise<unknown>;
}

export interface PagedTableProps<T> {
  query: PagedQuery<T>;
  /** The infinite query's key: reset to page 1 when a cursor goes stale (INVALID_CURSOR). */
  queryKey: QueryKey;
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  /** Visually hidden table caption ("My claims", "Claims waiting for my decision"). */
  caption: string;
  /** Rendered when nothing exists at all. */
  empty: React.ReactNode;
  /** Rendered when filters are active and match nothing. */
  filteredEmpty: React.ReactNode;
  isFiltered: boolean;
  /** Section name for <ForbiddenView> when the API answers 403 FORBIDDEN (a role changed). */
  forbiddenArea?: string;
  /** "claims" in "Showing 25 claims". */
  noun?: { one: string; many: string };
  'data-testid'?: string;
}

const SKELETON_ROWS = 5;
const isCode = (e: unknown, code: string): e is ApiError =>
  e instanceof ApiError && e.code === code;

export function PagedTable<T>({
  query,
  queryKey,
  columns,
  rowKey,
  caption,
  empty,
  filteredEmpty,
  isFiltered,
  forbiddenArea,
  noun = { one: 'claim', many: 'claims' },
  'data-testid': testId,
}: PagedTableProps<T>) {
  const qc = useQueryClient();
  const pages = query.data?.pages;

  if (!pages) {
    if (query.isError) {
      if (forbiddenArea && isCode(query.error, 'FORBIDDEN')) {
        return <ForbiddenView area={forbiddenArea} level={2} />;
      }
      return (
        <QueryErrorView
          level={2}
          title="This list couldn’t be loaded"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      );
    }
    return <TableSkeleton columns={columns} caption={caption} />;
  }

  const rows = pages.flatMap((p) => p.data);
  if (rows.length === 0) return <>{isFiltered ? filteredEmpty : empty}</>;

  const loadMore = async () => {
    const result = await query.fetchNextPage();
    if (isCode(result.error, 'INVALID_CURSOR')) {
      // The list changed under the cursor (or it was issued for other filters): start over.
      toast.info(describeApiError(result.error).title);
      await qc.resetQueries({ queryKey, exact: true });
    }
  };

  // INVALID_CURSOR is handled by loadMore (toast + back to page 1); anything else shows inline,
  // with the rows already loaded kept on screen and "Load more" as the retry.
  const nextPageError =
    query.isFetchNextPageError && !isCode(query.error, 'INVALID_CURSOR') ? query.error : null;
  // Placeholder rows from the previous filter while the new one loads (keepPreviousData).
  const refreshing = query.isPlaceholderData && query.isFetching;

  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {query.isRefetchError && (
        <RefreshError error={query.error} onRetry={() => void query.refetch()} />
      )}
      <Table aria-busy={refreshing || undefined} className={cn(refreshing && 'opacity-60')}>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead
                key={c.id}
                scope="col"
                className={cn(c.align === 'end' && 'text-right', c.className)}
              >
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={rowKey(row)}>
              {columns.map((c) => {
                const cls = cn(c.align === 'end' && 'text-right tabular-nums', c.className);
                return c.rowHeader ? (
                  <th
                    key={c.id}
                    scope="row"
                    className={cn('p-2 text-left align-middle font-medium whitespace-nowrap', cls)}
                  >
                    {c.cell(row)}
                  </th>
                ) : (
                  <TableCell key={c.id} className={cls}>
                    {c.cell(row)}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="flex flex-col items-center gap-3">
        <p aria-live="polite" className="text-muted-foreground text-xs">
          Showing {rows.length} {rows.length === 1 ? noun.one : noun.many}
          {query.hasNextPage ? '' : ' · end of list'}
        </p>
        {nextPageError !== null && <LoadMoreError error={nextPageError} />}
        {query.hasNextPage && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadMore()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Loading more…' : 'Load more'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** A background refetch failed: the rows on screen may be stale, so say so and offer Retry. */
function RefreshError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const d = describeApiError(error);
  return (
    <Alert>
      <AlertCircle aria-hidden />
      <AlertTitle className="line-clamp-none">This list couldn’t be refreshed</AlertTitle>
      <AlertDescription>
        <p>{d.title} The rows below may be out of date.</p>
        <ErrorReference id={d.requestId} />
        <Button type="button" variant="outline" size="sm" onClick={onRetry} className="mt-1">
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function LoadMoreError({ error }: { error: unknown }) {
  const d = describeApiError(error);
  return (
    <Alert variant="destructive" className="max-w-md">
      <AlertCircle aria-hidden />
      <AlertTitle className="line-clamp-none">More rows couldn’t be loaded</AlertTitle>
      <AlertDescription>
        <p>{d.title}</p>
        <ErrorReference id={d.requestId} />
      </AlertDescription>
    </Alert>
  );
}

function TableSkeleton<T>({
  columns,
  caption,
}: {
  columns: readonly Column<T>[];
  caption: string;
}) {
  return (
    <Table aria-busy="true">
      <TableCaption className="sr-only">{`${caption} (loading)`}</TableCaption>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead
              key={c.id}
              scope="col"
              className={cn(c.align === 'end' && 'text-right', c.className)}
            >
              {c.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <TableRow key={i}>
            {columns.map((c) => (
              <TableCell key={c.id}>
                <Skeleton className="h-4 w-full max-w-32" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
