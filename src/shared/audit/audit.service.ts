import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '../db/db.module.js';
import { activityLogs } from '../db/schema.js';
import { sql } from 'drizzle-orm';
import type { Role } from '../../modules/identity/decorators/roles.decorator.js';

export interface AuditActor {
  /** users.id — JWT `sub` */
  id: string;
  role: Role;
}

/** Append-only audit trail (activity_logs). Never updated, never deleted here. */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async log(
    actor: AuditActor | null,
    action: string,
    entityType: string,
    entityId: string | null,
    metadata?: Record<string, unknown> | null,
  ): Promise<void> {
    await this.db.insert(activityLogs).values({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      action,
      entityType,
      entityId,
      metadata: metadata ?? null,
    });
  }

  /** Read-only, filterable, paginated trail (admin viewer). */
  async list(q: {
    actorId?: string;
    action?: string;
    entityType?: string;
    from?: string;
    page: number;
    pageSize: number;
  }): Promise<{ rows: Array<Record<string, unknown>>; total: number; page: number; pageSize: number }> {
    const conds = [sql`TRUE`];
    if (q.actorId) conds.push(sql`actor_id = ${q.actorId}`);
    if (q.action) conds.push(sql`action ILIKE ${'%' + q.action + '%'}`);
    if (q.entityType) conds.push(sql`entity_type = ${q.entityType}`);
    if (q.from) conds.push(sql`created_at >= ${q.from}::timestamptz`);
    const where = sql.join(conds, sql` AND `);

    const pageSize = Math.min(q.pageSize, 100);
    const totals = await this.db.execute(
      sql`SELECT count(*)::int AS n FROM activity_logs WHERE ${where}`,
    );
    const total = ((totals.rows[0] as { n: number } | undefined)?.n) ?? 0;

    const rowsRes = await this.db.execute(sql`
      SELECT id, actor_id AS "actorId", actor_role AS "actorRole", action,
             entity_type AS "entityType", entity_id AS "entityId", metadata,
             created_at AS "createdAt"
      FROM activity_logs
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${(q.page - 1) * pageSize}
    `);
    return {
      rows: rowsRes.rows as Array<Record<string, unknown>>,
      total,
      page: q.page,
      pageSize,
    };
  }
}