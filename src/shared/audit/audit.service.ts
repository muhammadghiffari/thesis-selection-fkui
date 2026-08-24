import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '../db/db.module.js';
import { activityLogs } from '../db/schema.js';
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
}
