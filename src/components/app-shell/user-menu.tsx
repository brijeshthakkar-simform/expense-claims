'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useMe } from '@/components/app-shell/actor-provider';
import { Button } from '@/components/ui/button';
import { logout } from '@/features/auth/api';
import { ApiError, describeApiError } from '@/lib/api-client';
import { hardNavigate } from '@/lib/navigation';
import type { MeDto } from '@/shared/dto/auth';

function roleLabel(me: MeDto): string {
  if (me.isFinance) return 'Finance';
  if (me.role === 'ADMIN') return 'Admin';
  return me.canApprove ? 'Approver' : 'Employee';
}

export function UserMenu() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await logout();
    } catch (e) {
      // 401 = the session was already gone, which is the state we want.
      if (!(e instanceof ApiError && e.status === 401)) {
        const d = describeApiError(e);
        toast.error(`Sign out failed: ${d.title}`, { description: d.reference });
        setPending(false);
        return;
      }
    }
    queryClient.clear();
    // Not router.replace: a full navigation drops every in-memory claim, so the next person on a
    // shared machine sees nothing (05 §2.3).
    hardNavigate('/login');
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-col items-end text-right leading-tight">
        <span className="truncate text-sm font-medium">{me.name}</span>
        <span className="text-muted-foreground hidden truncate text-xs sm:block">{me.email}</span>
      </div>
      <span className="bg-secondary text-secondary-foreground rounded-full border px-2 py-0.5 text-xs font-medium">
        {roleLabel(me)}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void signOut()}
        disabled={pending}
      >
        <LogOut aria-hidden />
        {pending ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  );
}
