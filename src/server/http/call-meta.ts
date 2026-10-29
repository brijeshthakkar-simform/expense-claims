import 'server-only';

export interface CallMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Who is calling, for the access log and sessions.user_agent (04 §2.4). A pure function of the
 * request. `ip` is the first x-forwarded-for hop and is never stored in the database.
 */
export function callMeta(req: Pick<Request, 'headers'>): CallMeta {
  const firstHop = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return {
    ip: firstHop || null,
    userAgent: req.headers.get('user-agent')?.slice(0, 512) || null,
  };
}
