import { Receipt } from 'lucide-react';
import type { Metadata } from 'next';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { LoginForm } from '@/features/auth/login-form';
import { safeNext } from '@/lib/navigation';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const { next } = await searchParams;
  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="gap-3">
        <div className="flex items-center gap-2 font-semibold">
          <Receipt aria-hidden className="size-5" />
          Expense Claims
        </div>
        <h1 className="text-xl font-semibold">Sign in</h1>
        <CardDescription>Use your work email and password.</CardDescription>
      </CardHeader>
      <CardContent>
        {/* `next` is validated here, server-side, so the form only ever navigates to a local path. */}
        <LoginForm next={safeNext(next)} />
      </CardContent>
    </Card>
  );
}
