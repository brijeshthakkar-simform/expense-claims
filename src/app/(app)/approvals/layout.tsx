import { ForbiddenView } from '@/components/common/forbidden-view';
import { getMe } from '@/server/auth/rsc';

/**
 * Section gate for /approvals/** (05 §2.2): approvers only (`canApprove && role ≠ FINANCE`), so
 * FINANCE, or an employee with nobody to approve for, sees <ForbiddenView>. A UX gate only, guarding
 * no data: GET /approvals and the decision routes answer 403 FORBIDDEN on their own. The (app)
 * layout has already sent a signed-out visitor to /login.
 */
export default async function ApprovalsLayout({ children }: LayoutProps<'/approvals'>) {
  const me = await getMe(); // React-cached: the same lookup the (app) layout made
  return me?.canApprove && !me.isFinance ? children : <ForbiddenView area="Approvals" />;
}
