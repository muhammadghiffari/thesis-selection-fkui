import { Inject, Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import Redis from 'ioredis';
import type { DomainEvents } from '../../shared/event-bus/event-bus.service.js';
import { EventBus } from '../../shared/event-bus/event-bus.service.js';

export const REALTIME_CHANNEL = 'realtime:events';

/** Rooms: lobby:{periodId} · admin · lecturer:{id} · thesis:{id} */
export interface RealtimeMessage {
  event:
    | 'war.card'
    | 'selection.confirmed'
    | 'monitor'
    | 'banner'
    | 'lobby.time';
  room?: string;
  payload: Record<string, unknown>;
}

/**
 * Publishes realtime messages to Redis pub/sub. Every app instance
 * subscribes to the same channel and fans out to its local sockets —
 * stateless replicas stay in sync through the ONE transport.
 * In-process EventBus domain events are bridged here automatically.
 */
@Injectable()
export class RealtimeService {
  private publisher: Redis;
  private subscriber: Redis;
  private server: Server | null = null;

  constructor(@Inject(EventBus) private readonly events: EventBus) {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.publisher = new Redis(url, { maxRetriesPerRequest: null });
    this.subscriber = new Redis(url, { maxRetriesPerRequest: null });

    void this.subscriber.subscribe(REALTIME_CHANNEL).then(() => {
      this.subscriber.on('message', (_channel, raw) => {
        try {
          const msg = JSON.parse(raw) as RealtimeMessage;
          this.dispatchLocal(msg);
        } catch {
          // malformed payload — drop
        }
      });
    });

    this.bridgeDomainEvents();
  }

  attachServer(server: Server): void {
    this.server = server;
  }

  /** Direct publish (admin broadcast banner etc.). */
  async publish(message: RealtimeMessage): Promise<void> {
    await this.publisher.publish(REALTIME_CHANNEL, JSON.stringify(message));
  }

  private dispatchLocal(msg: RealtimeMessage): void {
    if (!this.server) return;
    if (msg.room) this.server.to(msg.room).emit(msg.event, msg.payload);
    else this.server.emit(msg.event, msg.payload);
  }

  /** EventBus → channel bridge: one subscription covers every domain event. */
  private bridgeDomainEvents(): void {
    const cardStatus =
      (type: 'war.lock' | 'war.taken' | 'war.available') =>
      (payload: DomainEvents[typeof type]) => {
        const status =
          type === 'war.lock' ? 'locked' : type === 'war.taken' ? 'taken' : 'available';
        const extra =
          type === 'war.lock'
            ? { lockedUntil: (payload as DomainEvents['war.lock']).lockedUntil }
            : {};
        void this.publish({
          event: 'war.card',
          room: `lobby:${(payload as { periodId: string }).periodId}`,
          payload: {
            periodId: (payload as { periodId: string }).periodId,
            thesisId: (payload as { thesisId: string }).thesisId,
            status,
            ...extra,
          },
        });
        void this.publish({
          event: 'war.card',
          room: `thesis:${(payload as { thesisId: string }).thesisId}`,
          payload: {
            periodId: (payload as { periodId: string }).periodId,
            thesisId: (payload as { thesisId: string }).thesisId,
            status,
            ...extra,
          },
        });
      };

    this.events.on('war.lock', cardStatus('war.lock'));
    this.events.on('war.taken', cardStatus('war.taken'));
    this.events.on('war.available', cardStatus('war.available'));

    this.events.on('selection.confirmed', (payload) => {
      void this.publish({ event: 'monitor', room: 'admin', payload: { ...payload } });
    });
    this.events.on('period.scheduled', (payload) => {
      void this.publish({ event: 'monitor', room: 'admin', payload: { ...payload } });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }
}
