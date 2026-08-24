import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { EventBus } from '../../shared/event-bus/event-bus.service.js';
import { selectionPeriods, type PeriodSettings } from '../../shared/db/schema.js';
import { assertTransition, type PeriodStatus } from './lifecycle.js';

type PeriodRow = typeof selectionPeriods.$inferSelect;

interface CreateInput {
  name: string;
  academicYear: string;
  opensAt?: string;
  closesAt?: string;
}

@Injectable()
export class PeriodsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  list(): Promise<PeriodRow[]> {
    return this.db
      .select()
      .from(selectionPeriods)
      .where(isNull(selectionPeriods.deletedAt))
      .orderBy(desc(selectionPeriods.createdAt));
  }

  async get(id: string): Promise<PeriodRow | null> {
    const [row] = await this.db
      .select()
      .from(selectionPeriods)
      .where(and(eq(selectionPeriods.id, id), isNull(selectionPeriods.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async create(dto: CreateInput): Promise<PeriodRow> {
    const [row] = await this.db
      .insert(selectionPeriods)
      .values({
        name: dto.name,
        academicYear: dto.academicYear,
        status: 'draft',
        opensAt: dto.opensAt ? new Date(dto.opensAt) : null,
        closesAt: dto.closesAt ? new Date(dto.closesAt) : null,
      })
      .returning();
    if (!row) throw new Error('period insert returned no row');
    return row;
  }

  /** Draft-only edits; anything else is a lifecycle conflict. */
  async update(
    id: string,
    dto: Partial<CreateInput & PeriodSettings>,
  ): Promise<PeriodRow> {
    const period = await this.mustGet(id);
    if (period.status !== 'draft') {
      throw new ConflictException(`Only draft periods can be edited (current: ${period.status})`);
    }
    const patch: Partial<typeof selectionPeriods.$inferInsert> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.academicYear !== undefined) patch.academicYear = dto.academicYear;
    if (dto.opensAt !== undefined) patch.opensAt = new Date(dto.opensAt);
    if (dto.closesAt !== undefined) patch.closesAt = new Date(dto.closesAt);

    const settingsPatch: Partial<PeriodSettings> = {};
    for (const key of ['lock_duration_sec', 'undo_window_sec', 'grace_period_sec', 'required_selections', 'attempts_default', 'watch_max'] as const) {
      const value = (dto as Record<string, unknown>)[key];
      if (value !== undefined) settingsPatch[key] = value as number;
    }
    if ((dto as { mode?: string }).mode !== undefined) {
      settingsPatch.mode = (dto as { mode: string }).mode as PeriodSettings['mode'];
    }
    if (Object.keys(settingsPatch).length > 0) {
      patch.settings = { ...period.settings, ...settingsPatch };
    }

    const [row] = await this.db
      .update(selectionPeriods)
      .set(patch)
      .where(eq(selectionPeriods.id, id))
      .returning();
    return row!;
  }

  async softDelete(id: string): Promise<void> {
    const period = await this.mustGet(id);
    if (period.status !== 'draft') {
      throw new ConflictException(`Only draft periods can be deleted (current: ${period.status})`);
    }
    await this.db
      .update(selectionPeriods)
      .set({ deletedAt: new Date() })
      .where(eq(selectionPeriods.id, id));
  }

  /** Guarded lifecycle move with a pre-open sanity rule: scheduled needs a date. */
  async transition(id: string, to: PeriodStatus): Promise<PeriodRow> {
    const period = await this.mustGet(id);
    assertTransition(period.status as PeriodStatus, to);

    if ((to === 'scheduled' || to === 'open') && !period.opensAt) {
      throw new ConflictException('opens_at must be set before scheduling/opening the period');
    }

    const [row] = await this.db
      .update(selectionPeriods)
      .set({ status: to })
      .where(eq(selectionPeriods.id, id))
      .returning();

    // cross-module side effects (reminder scheduling) ride the event bus
    if (to === 'scheduled' && row) {
      this.events.emit('period.scheduled', {
        periodId: row.id,
        opensAt: (row.opensAt as Date).toISOString(),
        closesAt: row.closesAt ? row.closesAt.toISOString() : null,
      });
    }
    return row!;
  }

  /**
   * Clones CONFIG ONLY into a fresh draft: settings, name, academic year.
   * Selections/enrollments/theses are history/content and are NOT copied —
   * next year's catalog arrives via bulk import.
   */
  async clone(id: string): Promise<PeriodRow> {
    const source = await this.mustGet(id);
    const [row] = await this.db
      .insert(selectionPeriods)
      .values({
        name: `${source.name} (clone)`,
        academicYear: source.academicYear,
        status: 'draft',
        settings: source.settings,
        clonedFrom: source.id,
        opensAt: null,
        closesAt: null,
      })
      .returning();
    if (!row) throw new Error('clone insert returned no row');
    return row;
  }

  private async mustGet(id: string): Promise<PeriodRow> {
    const period = await this.get(id);
    if (!period) throw new NotFoundException('period not found');
    return period;
  }
}
