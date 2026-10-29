'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { QueryErrorView } from '@/components/common/query-error-view';
import { useCategories, useCreateClaim } from '@/features/claims/api';
import { ClaimForm } from '@/features/claims/claim-form';
import { ClaimFormSkeleton } from '@/features/claims/claim-form-skeleton';
import { toCreatePayload } from '@/features/claims/form-schema';
import { UnsavedLineReceipts } from '@/features/claims/receipts/line-receipts';
import { ApiError } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import type { ClaimDetail } from '@/shared/dto/claims';
import type { ReplaceClaimInput } from '@/shared/schemas/claims';

/** /claims/new (05 §4.2): ClaimForm in create mode; Save draft POSTs, then opens the new claim. */
export function NewClaimScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const categoriesQ = useCategories();
  const create = useCreateClaim();
  const [created, setCreated] = useState<ClaimDetail | null>(null);

  const onSave = async (payload: ReplaceClaimInput): Promise<ClaimDetail> => {
    const dto = await create.mutateAsync(toCreatePayload(payload));
    setCreated(dto); // swaps the form out, so a second click can't create a second claim
    toast.success(`Draft ${dto.claimNumber} saved`);
    router.replace(`/claims/${dto.id}`);
    return dto;
  };

  const onSaveError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'CATEGORY_INACTIVE') {
      void qc.invalidateQueries({ queryKey: qk.categories });
    }
    return false;
  };

  let body: React.ReactNode;
  if (created) {
    body = (
      <p role="status" className="text-muted-foreground text-sm">
        Draft saved. Opening{' '}
        <Link href={`/claims/${created.id}`} className="underline underline-offset-4">
          {created.claimNumber}
        </Link>
        …
      </p>
    );
  } else if (categoriesQ.isError) {
    body = (
      <QueryErrorView
        level={2}
        title="Categories couldn’t be loaded"
        error={categoriesQ.error}
        onRetry={() => void categoriesQ.refetch()}
      />
    );
  } else if (!categoriesQ.data) {
    body = <ClaimFormSkeleton />;
  } else {
    body = (
      <ClaimForm
        categories={categoriesQ.data}
        onSave={onSave}
        onSaveError={onSaveError}
        receipts={({ n }) => <UnsavedLineReceipts n={n} hint="Save the draft to attach receipts" />}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb">
          <ol className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm">
            <li>
              <Link
                href="/claims"
                className="hover:text-foreground underline-offset-4 hover:underline"
              >
                My claims
              </Link>
            </li>
            <li aria-hidden>/</li>
            <li aria-current="page" className="text-foreground">
              New claim
            </li>
          </ol>
        </nav>
        <h1 className="text-2xl font-semibold">New claim</h1>
        <p className="text-muted-foreground text-sm">
          Save a draft now and keep editing it later. The total is calculated by the database from
          the line items when you save.
        </p>
      </header>
      {body}
    </div>
  );
}
