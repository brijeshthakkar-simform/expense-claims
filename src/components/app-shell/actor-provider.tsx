'use client';

import { createContext, use } from 'react';
import type { MeDto } from '@/shared/dto/auth';

const ActorContext = createContext<MeDto | null>(null);

/**
 * Identity for client components, filled once by `(app)/layout.tsx` from getActor(). Capability
 * flags drive navigation only; the API re-decides every request.
 */
export function ActorProvider({ me, children }: { me: MeDto; children: React.ReactNode }) {
  return <ActorContext value={me}>{children}</ActorContext>;
}

/** The signed-in user, or null outside the (app) layout (e.g. a component rendered in a test). */
export function useMaybeMe(): MeDto | null {
  return use(ActorContext);
}

export function useMe(): MeDto {
  const me = use(ActorContext);
  if (!me) throw new Error('useMe() must be used inside <ActorProvider> (the (app) layout)');
  return me;
}
