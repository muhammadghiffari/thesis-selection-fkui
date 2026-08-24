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
    | 'swap.state'
    | 'notification'
    | 'monitor'
    | 'banner';
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

    const swapState =
      (
        state: string,
        extra?: (payload: Record<string, unknown>) => Record<string, unknown>,
      ) =>
      (payload: Record<string, unknown>) => {
        const body = { thesisId: payload.thesisId, state, ...(extra ? extra(payload) : {}) };
        void this.publish({ event: 'swap.state', room: `lobby:${payload.periodId}`, payload: body });
        void this.publish({ event: 'swap.state', room: `thesis:${payload.thesisId}`, payload: body });
      };

    this.events.on('swap.requested', swapState('swap_requested'));
    this.events.on('swap.approved', swapState('pending_release', (p) => ({ graceUntil: p.graceUntil })));
    this.events.on('swap.reclaimed', swapState('owned'));

    // rejection/cancel restore ownership → cards read as taken again
    for (const evt of ['swap.cancelled', 'swap.rejected'] as const) {
      this.events.on(evt, (payload: Record<string, unknown>) => {
        void this.publish({
          event: 'war.card',
          room: `lobby:${payload.periodId}`,
          payload: { periodId: payload.periodId, thesisId: payload.thesisId, status: 'taken' },
        });
        void this.publish({
          event: 'war.card',
          room: `thesis:${payload.thesisId}`,
          payload: { periodId: payload.periodId, thesisId: payload.thesisId, status: 'taken' },
        });
      });
    }

    // swap release frees the title for everyone
    this.events.on('swap.released', (payload: Record<string, unknown>) => {
      void this.publish({
        event: 'war.card',
        room: `lobby:${payload.periodId}`,
        payload: { periodId: payload.periodId, thesisId: payload.thesisId, status: 'available' },
      });
    });

    // per-user in-app notifications (watchers)
    this.events.on('watcher.available', (payload) => {
      void this.publish({
        event: 'notification',
        room: `user:${(payload as { userId: string }).userId}`,
        payload: { ...payload },
      });
    });

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
