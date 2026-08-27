import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from './db.module.js';
import { selectionPeriods } from './schema.js';

/**
 * Archive freeze: archived periods are read-only. Catalog/claims/receipts
 * stay viewable (GET paths untouched); mutations must call this guard.
 * 423 Locked communicates "frozen" distinctly from lifecycle conflicts.
 */
export async function assertPeriodMutable(db: Database, periodId: string): Promise<void> {
  const [row] = await db
    .select({ status: selectionPeriods.status })
    .from(selectionPeriods)
    .where(eq(selectionPeriods.id, periodId))
    .limit(1);
  if (row?.status === 'archived') {
    throw new ConflictException('This period is archived and read-only');
  }
}
