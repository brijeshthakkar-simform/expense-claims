import 'server-only';
import { getDb } from '@/server/db/client';
import type { Tx } from '@/server/db/tx';

// Reference data: expense_app has SELECT only (C-16). Categories are retired (is_active = false),
// never deleted, so old lines keep their category.

export interface CategoryRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

const SELECT = { id: true, code: true, name: true, isActive: true } as const;

/** Every category, active and retired, in display order. */
export function listCategories(): Promise<CategoryRow[]> {
  return getDb().category.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: SELECT,
  });
}

/** The categories among `ids` that exist (inside the caller's transaction). */
export function findCategoriesByIds(tx: Tx, ids: readonly string[]): Promise<CategoryRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return tx.category.findMany({ where: { id: { in: [...ids] } }, select: SELECT });
}
