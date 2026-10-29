'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ErrorReference } from '@/components/common/error-reference';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { login } from '@/features/auth/api';
import { ApiError, applyServerIssues, describeApiError } from '@/lib/api-client';
import { hardNavigate } from '@/lib/navigation';
import { LoginInput } from '@/shared/schemas/auth';

type FormIn = z.input<typeof LoginInput>;
type FormOut = z.output<typeof LoginInput>;

interface FormError {
  message: string;
  requestId?: string;
}

/** Form-level copy per 05 §5.2. INVALID_CREDENTIALS never says which part was wrong. */
function formErrorFor(e: unknown): FormError {
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CREDENTIALS') return { message: 'Email or password is incorrect' };
    if (e.code === 'RATE_LIMITED') return { message: 'Too many attempts. Try again in a moment' };
    return { message: describeApiError(e).title, requestId: e.requestId };
  }
  return { message: 'Something went wrong' };
}

const fieldName = (path: (string | number)[]) =>
  path[0] === 'email' || path[0] === 'password' ? path[0] : null;

export function LoginForm({ next }: { next: string }) {
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(LoginInput),
    defaultValues: { email: '', password: '' },
  });
  const { errors } = form.formState;
  const [formError, setFormError] = useState<FormError | null>(null);
  const mutation = useMutation({ mutationFn: login, meta: { handlesErrors: true } });
  const busy = mutation.isPending || mutation.isSuccess; // stay disabled while navigating away

  useEffect(() => form.setFocus('email'), [form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await mutation.mutateAsync(values);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') {
        const unmapped = applyServerIssues(e, form.setError, fieldName);
        if (unmapped.length === 0) return;
      }
      // The alert (role="alert") announces the message; on bad credentials the password is
      // cleared and focused so the user can retype it straight away.
      setFormError(formErrorFor(e));
      if (e instanceof ApiError && e.code === 'INVALID_CREDENTIALS') {
        form.resetField('password');
        form.setFocus('password');
      }
      return;
    }
    hardNavigate(next); // `next` was validated server-side by safeNext()
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <FieldGroup className="gap-5">
        {formError && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden />
            <AlertTitle className="line-clamp-none">{formError.message}</AlertTitle>
            {formError.requestId && (
              <AlertDescription>
                <ErrorReference id={formError.requestId} />
              </AlertDescription>
            )}
          </Alert>
        )}

        <Field data-invalid={!!errors.email || undefined}>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            spellCheck={false}
            aria-invalid={!!errors.email || undefined}
            aria-describedby={errors.email ? 'email-error' : undefined}
            {...form.register('email')}
          />
          <FieldError id="email-error" errors={[errors.email]} />
        </Field>

        <Field data-invalid={!!errors.password || undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={!!errors.password || undefined}
            aria-describedby={errors.password ? 'password-error' : undefined}
            {...form.register('password')}
          />
          <FieldError id="password-error" errors={[errors.password]} />
        </Field>

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </FieldGroup>
    </form>
  );
}
