import { AppError } from '@/server/errors/app-error';
import { defineRoute } from '@/server/http/define-route';

/**
 * Every unknown /api/v1 path, every method (04 §3.3). Authenticated on purpose: an anonymous caller
 * gets 401 before 404, so probing learns nothing about the route map.
 */
const routeNotFound = () =>
  defineRoute({
    auth: 'required',
    handler: () => {
      throw new AppError('ROUTE_NOT_FOUND');
    },
  });

export const GET = routeNotFound();
export const HEAD = routeNotFound();
export const POST = routeNotFound();
export const PUT = routeNotFound();
export const PATCH = routeNotFound();
export const DELETE = routeNotFound();
export const OPTIONS = routeNotFound();
