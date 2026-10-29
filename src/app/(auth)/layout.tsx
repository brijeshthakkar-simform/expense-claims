import { redirect } from 'next/navigation';
import { DEFAULT_LANDING } from '@/lib/navigation';
import { getActor } from '@/server/auth/rsc';

/** Signed-in users have nothing to do on /login (05 §2.2). */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getActor()) redirect(DEFAULT_LANDING);
  return (
    <main id="main" className="flex flex-1 items-center justify-center px-4 py-12">
      {children}
    </main>
  );
}
