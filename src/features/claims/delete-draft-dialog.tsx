'use client';

import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useDeleteDraft } from '@/features/claims/api';

/**
 * Rendered only when allowedActions contains DELETE (never-submitted drafts, 05 §6.7). The server
 * still re-checks: CLAIM_HAS_HISTORY / CLAIM_LOCKED arrive as a toast and the view refetches.
 */
export function DeleteDraftDialog({
  claimId,
  claimNumber,
  onDeleted,
}: {
  claimId: string;
  claimNumber: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const del = useDeleteDraft(claimId);

  const confirm = (e: React.MouseEvent) => {
    e.preventDefault(); // keep the dialog open (and its buttons disabled) until the server answers
    del.mutate(undefined, {
      onSuccess: () => {
        setOpen(false);
        onDeleted();
      },
      onError: () => setOpen(false),
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !del.isPending && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" className="text-destructive">
          <Trash2 aria-hidden />
          Delete draft
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
          <AlertDialogDescription>
            {claimNumber} and all its line items will be removed. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>Keep draft</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={del.isPending} onClick={confirm}>
            {del.isPending ? 'Deleting…' : 'Delete draft'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
