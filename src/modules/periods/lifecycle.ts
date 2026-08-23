import { ConflictException } from '@nestjs/common';

/** Canonical lifecycle from AGENTS.md / SCHEMA.sql CHECK constraint. */
export type PeriodStatus = 'draft' | 'scheduled' | 'open' | 'closed' | 'archived';

const TRANSITIONS: Record<PeriodStatus, PeriodStatus[]> = {
  draft: ['scheduled'],
  scheduled: ['open'],
  open: ['closed'],
  closed: ['archived'],
  archived: [],
};

export function canTransition(from: PeriodStatus, to: PeriodStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws 409 ConflictException on illegal jumps. */
export function assertTransition(from: PeriodStatus, to: PeriodStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`Cannot transition period from '${from}' to '${to}'`);
  }
}
