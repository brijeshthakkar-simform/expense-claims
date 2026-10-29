import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ActorProvider } from '@/components/app-shell/actor-provider';
import { AppShell } from '@/components/app-shell/app-shell';
import { loginHref, PAGE_PATH_HEADER } from '@/lib/navigation';
import { getMe } from '@/server/auth/rsc';

/**
 * Identity, nav and the redirect, nothing else (05 §2.2): no claim data is read here. A UX gate
 * only; every /api/v1 handler authenticates on its own. Reached with a cookie that is no longer
 * valid (proxy only checks presence), it sends the user to /login?next=<this page>.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe(); // getActor() + the MeDto capability flags
  if (!me) redirect(loginHref((await headers()).get(PAGE_PATH_HEADER)));
  return (
    <ActorProvider me={me}>
      <AppShell>{children}</AppShell>
    </ActorProvider>
  );
}
