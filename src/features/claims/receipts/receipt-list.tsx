'use client';

import { FileImage, FileText, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatBytes, receiptContentHref } from '@/features/claims/receipts/upload';
import { cn } from '@/lib/utils';

/** What a receipt row needs: a live ReceiptDto, or a snapshot receipt (`receiptId` → `id`). */
export interface ReceiptFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * A line's receipts (05 §8): each one a plain download link (the server streams it as an
 * attachment after its visibility check), plus Remove with an inline confirm when `onRemove` is
 * given, which the caller does only while allowedActions contains EDIT.
 */
export function ReceiptList({
  claimId,
  receipts,
  lineNumber,
  onRemove,
  removingId,
  className,
}: {
  claimId: string;
  receipts: readonly ReceiptFile[];
  lineNumber: number;
  onRemove?: (receipt: ReceiptFile) => void;
  /** The receipt whose DELETE is in flight. */
  removingId?: string;
  className?: string;
}) {
  if (receipts.length === 0) return null;
  return (
    <ul aria-label={`Receipts for line ${lineNumber}`} className={cn('flex flex-col', className)}>
      {receipts.map((r) => (
        <ReceiptItem
          key={r.id}
          claimId={claimId}
          receipt={r}
          lineNumber={lineNumber}
          onRemove={onRemove}
          removing={removingId === r.id}
        />
      ))}
    </ul>
  );
}

function ReceiptItem({
  claimId,
  receipt: r,
  lineNumber,
  onRemove,
  removing,
}: {
  claimId: string;
  receipt: ReceiptFile;
  lineNumber: number;
  onRemove?: (receipt: ReceiptFile) => void;
  removing: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const Icon = r.contentType.startsWith('image/') ? FileImage : FileText;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (returnFocus.current) removeRef.current?.focus();
    returnFocus.current = false;
  }, [confirming]);

  const cancel = () => {
    returnFocus.current = true;
    setConfirming(false);
  };

  return (
    <li
      data-testid="receipt"
      className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
      aria-busy={removing || undefined}
    >
      <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      <a
        href={receiptContentHref(claimId, r.id)}
        download
        className="min-w-0 font-medium break-all underline-offset-4 hover:underline"
      >
        <span className="sr-only">Download</span> {r.fileName}
      </a>
      <span className="text-muted-foreground text-xs whitespace-nowrap tabular-nums">
        {formatBytes(r.sizeBytes)}
      </span>
      {onRemove &&
        (removing ? (
          <span role="status" className="text-muted-foreground text-xs">
            Removing…
          </span>
        ) : confirming ? (
          <span
            className="flex flex-wrap items-center gap-1"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
          >
            <span className="text-xs">Remove this receipt?</span>
            <Button
              ref={confirmRef}
              type="button"
              size="xs"
              variant="destructive"
              aria-label={`Confirm removing ${r.fileName} from line ${lineNumber}`}
              onClick={() => {
                setConfirming(false);
                onRemove(r);
              }}
            >
              Remove
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            ref={removeRef}
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Remove receipt ${r.fileName} from line ${lineNumber}`}
            onClick={() => setConfirming(true)}
          >
            <X aria-hidden />
          </Button>
        ))}
    </li>
  );
}
