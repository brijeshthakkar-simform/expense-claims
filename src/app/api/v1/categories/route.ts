import { defineRoute } from '@/server/http/define-route';
import { ok } from '@/server/http/responses';
import * as categoriesService from '@/server/services/categories.service';

/** GET /api/v1/categories → 200 `{ data: CategoryDto[] }` (active and retired, with `isActive`). */
export const GET = defineRoute({
  auth: 'required',
  handler: async ({ serviceCtx }) => ok(await categoriesService.listCategories(serviceCtx)),
});
