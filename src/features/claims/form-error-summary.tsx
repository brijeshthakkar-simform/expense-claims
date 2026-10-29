'use client';

import { AlertCircle } from 'lucide-react';
import type { FieldErrors, Path } from 'react-hook-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { ClaimFormInput } from '@/features/claims/form-schema';

const LINE_FIELD_LABELS = {
  expenseDate: 'Date',
  categoryId: 'Category',
  description: 'Description',
  merchant: 'Merchant',
  amount: 'Amount',
} as const;

interface Problem {
  key: string;
  label: string;
  message: string;
  focus?: Path<ClaimFormInput>;
}

function problemsOf(errors: FieldErrors<ClaimFormInput>): Problem[] {
  const out: Problem[] = [];
  if (errors.title?.message) {
    out.push({ key: 'title', label: 'Title', message: errors.title.message, focus: 'title' });
  }
  const lines = errors.lineItems;
  if (lines) {
    // Array-level issues (count, claim cap) land on `.root` (resolver) or the array itself.
    const arrayMessage = lines.root?.message ?? lines.message;
    if (arrayMessage) out.push({ key: 'lines', label: 'Line items', message: arrayMessage });
    if (Array.isArray(lines)) {
      lines.forEach((line, i) => {
        if (!line) return;
        for (const [field, label] of Object.entries(LINE_FIELD_LABELS)) {
          const message = (line as Record<string, { message?: string } | undefined>)[field]
            ?.message;
          if (message) {
            out.push({
              key: `${i}.${field}`,
              label: `Line ${i + 1} · ${label}`,
              message,
              focus: `lineItems.${i}.${field}` as Path<ClaimFormInput>,
            });
          }
        }
      });
    }
  }
  return out;
}

/**
 * One announced summary of every field problem after a save attempt (05 §14), each linked to its
 * control. Field-level messages stay next to the controls too.
 */
export function FormErrorSummary({
  errors,
  onFocus,
}: {
  errors: FieldErrors<ClaimFormInput>;
  onFocus: (name: Path<ClaimFormInput>) => void;
}) {
  const problems = problemsOf(errors);
  if (problems.length === 0) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden />
      <AlertTitle className="line-clamp-none">
        {problems.length === 1
          ? 'Fix 1 problem before saving'
          : `Fix ${problems.length} problems before saving`}
      </AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {problems.map((p) => (
            <li key={p.key}>
              {p.focus ? (
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => p.focus && onFocus(p.focus)}
                >
                  {p.label}
                </button>
              ) : (
                p.label
              )}
              : {p.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
