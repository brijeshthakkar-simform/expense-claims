import { z } from 'zod';

/** GET /api/v1/categories items (C-10). Inactive categories are listed too, flagged. */
export const CategoryDto = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  isActive: z.boolean(),
});
export type CategoryDto = z.infer<typeof CategoryDto>;
