import { ForbiddenView } from '@/components/common/forbidden-view';
import { getMe } from '@/server/auth/rsc';

/**
 * Section gate for /finance/** (05 §2.2, §11): FINANCE only, so everyone else sees <ForbiddenView>
 * ("You don't have access to Finance."). A UX gate only, guarding no data: GET /finance/claims and
 * the export answer 403 FORBIDDEN on their own, and their services check the role again (D-04). The
 * (app) layout has already sent a signed-out visitor to /login.
 */
export default async function FinanceLayout({ children }: LayoutProps<'/finance'>) {
  const me = await getMe(); // React-cached: the same lookup the (app) layout made
  return me?.isFinance ? children : <ForbiddenView area="Finance" />;
}
