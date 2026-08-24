import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * Minimal in-process event bus for cross-module communication (AGENTS.md
 * rule 9: modules must NOT import each other directly). F6 realtime will
 * bridge these events to Socket.IO over the same bus.
 */
export interface DomainEvents {
  'period.scheduled': { periodId: string; opensAt: string; closesAt: string | null };
  'selection.confirmed': {
    userId: string;
    periodId: string;
    selectionId: string;
    thesisTitle: string;
    lecturerName: string | null;
    referenceNumber: string | null;
    confirmedAt: string;
  };
}

@Injectable()
export class EventBus {
  private readonly subject = new Subject<{ type: keyof DomainEvents; payload: unknown }>();

  emit<K extends keyof DomainEvents>(type: K, payload: DomainEvents[K]): void {
    this.subject.next({ type, payload });
  }

  on<K extends keyof DomainEvents>(
    type: K,
    handler: (payload: DomainEvents[K]) => void,
  ): () => void {
    const sub = this.subject.subscribe({
      next: (event) => {
        if (event.type === type) handler(event.payload as DomainEvents[K]);
      },
    });
    return () => sub.unsubscribe();
  }
}
