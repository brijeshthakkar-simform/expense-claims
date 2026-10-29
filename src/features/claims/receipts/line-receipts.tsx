'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ErrorReference } from '@/components/common/error-reference';
import { Button, buttonVariants } from '@/components/ui/button';
import { useDeleteReceipt, useUploadReceipt } from '@/features/claims/api';
import { ReceiptList, type ReceiptFile } from '@/features/claims/receipts/receipt-list';
import {
  checkReceiptFile,
  describeReceiptError,
  LIMIT_COPY,
  RECEIPT_ACCEPT,
} from '@/features/claims/receipts/upload';
import { ApiError } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import type { ReceiptDto } from '@/shared/dto/claims';
import { MAX_RECEIPTS_PER_LINE } from '@/shared/policy';

/** What the line editor tells the receipts slot about one row. */
export interface ReceiptSlotProps {
  /** The saved line's server id; absent on a row that hasn't been saved yet. */
  lineItemId?: string;
  /** 1-based line number, for labels ("Attach receipt to line 2"). */
  n: number;
}

const HINT = 'JPEG, PNG, WebP or PDF, up to 10 MB';

function ReceiptsLabel({ id, n }: { id?: string; n: number }) {
  return (
    <span id={id} className="text-muted-foreground text-xs font-medium">
      Receipts<span className="sr-only"> for line {n}</span>
    </span>
  );
}

/**
 * Attach, download and remove for one saved line while the claim is editable (05 §8). Receipts
 * render from the server DTO, not form state, so an upload refreshes the list without touching
 * unsaved edits. 413/422 show under the list; the codes that mean the claim moved on (409
 * CLAIM_LOCKED / CLAIM_NOT_EDITABLE, 404 claim or line) go to `onClaimError`, which refetches
 * and toasts, after which allowedActions decides whether this section still renders.
 */
export function LineReceipts({
  claimId,
  lineItemId,
  n,
  receipts,
  onClaimError,
}: {
  claimId: string;
  lineItemId: string;
  n: number;
  receipts: readonly ReceiptDto[];
  /** Returns true when the screen has shown the error itself. */
  onClaimError?: (error: unknown) => boolean;
}) {
  const qc = useQueryClient();
  const upload = useUploadReceipt(claimId);
  const remove = useDeleteReceipt(claimId);
  const [error, setError] = useState<{ title: string; requestId?: string } | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const labelId = `${uid}-label`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const uploading = upload.isPending;
  const uploadingName = upload.isPending ? upload.variables.file.name : null;
  const atMax = receipts.length >= MAX_RECEIPTS_PER_LINE;

  const fail = (e: unknown) => {
    if (onClaimError?.(e)) {
      setError(null);
      return;
    }
    // The list on screen is stale (removed elsewhere, or full from another tab): refetch it.
    if (e instanceof ApiError && ['RECEIPT_NOT_FOUND', 'RECEIPT_LIMIT_REACHED'].includes(e.code)) {
      void qc.invalidateQueries({ queryKey: qk.claim(claimId) });
    }
    setError(describeReceiptError(e));
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so the same file can be picked again after a failure
    if (!file) return;
    const problem = checkReceiptFile(file);
    if (problem) {
      setError({ title: problem });
      return;
    }
    setError(null);
    upload.mutate(
      { lineItemId, file },
      {
        onSuccess: (r) => toast.success(`${r.fileName} attached to line ${n}`),
        onError: fail,
      },
    );
  };

  const onRemove = (r: ReceiptFile) => {
    setError(null);
    remove.mutate(r.id, {
      onSuccess: () => {
        toast.success(`${r.fileName} removed from line ${n}`);
        groupRef.current?.focus(); // the row that held focus is gone
      },
      onError: fail,
    });
  };

  return (
    <div
      ref={groupRef}
      role="group"
      aria-labelledby={labelId}
      tabIndex={-1}
      className="flex flex-col gap-1.5 outline-none"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ReceiptsLabel id={labelId} n={n} />
        {receipts.length === 0 && !uploading && (
          <span className="text-muted-foreground text-xs">None attached</span>
        )}
      </div>
      <ReceiptList
        claimId={claimId}
        receipts={receipts}
        lineNumber={n}
        onRemove={onRemove}
        removingId={remove.isPending ? remove.variables : undefined}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {atMax ? (
          <p className="text-muted-foreground text-xs">{LIMIT_COPY}</p>
        ) : (
          <>
            {/* The input is the control (visually hidden, still focusable); the label is its face. */}
            <label
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'has-[:focus-visible]:border-ring has-[:focus-visible]:ring-ring/50 cursor-pointer has-[:focus-visible]:ring-[3px]',
                uploading && 'pointer-events-none opacity-50',
              )}
            >
              <Paperclip aria-hidden />
              {uploading ? 'Uploading…' : 'Attach receipt'}
              <input
                type="file"
                accept={RECEIPT_ACCEPT}
                className="sr-only"
                aria-label={`Attach receipt to line ${n}`}
                aria-describedby={error ? `${errorId} ${hintId}` : hintId}
                aria-invalid={error ? true : undefined}
                disabled={uploading}
                onChange={onPick}
              />
            </label>
            {uploadingName ? (
              <span role="status" className="text-muted-foreground text-xs break-all">
                Uploading {uploadingName}…
              </span>
            ) : (
              <span id={hintId} className="text-muted-foreground text-xs">
                {HINT}
              </span>
            )}
          </>
        )}
      </div>
      {error && (
        <div id={errorId} role="alert" className="text-destructive text-sm">
          <p>{error.title}</p>
          <ErrorReference id={error.requestId} />
        </div>
      )}
    </div>
  );
}

/** A row without a server id yet: receipts attach to saved lines only (05 §4.2, §8). */
export function UnsavedLineReceipts({
  n,
  hint = 'Save the claim to attach receipts',
}: {
  n: number;
  hint?: string;
}) {
  const hintId = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ReceiptsLabel n={n} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled
        aria-label={`Attach receipt to line ${n}`}
        aria-describedby={hintId}
      >
        <Paperclip aria-hidden />
        Attach receipt
      </Button>
      <span id={hintId} className="text-muted-foreground text-xs">
        {hint}
      </span>
    </div>
  );
}
