import 'server-only';
import * as categoriesRepo from '@/server/repositories/categories.repo';
import { toCategoryDto } from '@/server/services/claim-dto';
import type { ServiceCtx } from '@/server/services/context';
import type { CategoryDto } from '@/shared/dto/categories';

/**
 * GET /api/v1/categories: active and retired categories (the editor still shows a retired one on
 * an old line). Any signed-in actor may read them; `ctx` keeps the uniform C-26 signature.
 */
export async function listCategories(ctx: ServiceCtx): Promise<CategoryDto[]> {
  void ctx;
  return (await categoriesRepo.listCategories()).map(toCategoryDto);
}
