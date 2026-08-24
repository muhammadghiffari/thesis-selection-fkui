import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { and, eq } from 'drizzle-orm';
import { Server, Socket } from 'socket.io';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { lecturers, periodEnrollments, students } from '../../shared/db/schema.js';
import type { AuthUser } from '../identity/auth-user.js';
import { RealtimeService } from './realtime.service.js';

interface HandshakeAuth {
  token?: string;
}

/**
 * Socket.IO gateway on the SAME http server. Handshake requires a valid
 * session JWT; rooms are joined only after server-side verification
 * (enrollment for lobby:{periodId}, role for admin/lecturer rooms).
 */
@WebSocketGateway({ cors: { origin: '*' }, transports: ['websocket'] })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly userBySocket = new Map<string, AuthUser>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly realtime: RealtimeService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  afterInit(): void {
    this.realtime.attachServer(this.server);
  }

  async handleConnection(client: Socket): Promise<void> {
    const auth = client.handshake.auth as HandshakeAuth;
    try {
      const payload = await this.jwt.verifyAsync<AuthUser>(String(auth.token ?? ''));
      this.userBySocket.set(client.id, payload);
      if (payload.role === 'admin') await client.join('admin');
    } catch {
      this.logger.warn(`rejected unauthenticated socket ${client.id}`);
      client.emit('unauthorized', { message: 'valid token required' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.userBySocket.delete(client.id);
  }

  /**
   * Students join their period's lobby room — enrollment verified server-side.
   * Reconciliation contract: clients re-fetch authoritative state over REST
   * after (re)connect; sockets carry NO backlog.
   */
  @SubscribeMessage('lobby.subscribe')
  async subscribeLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { periodId?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    const user = this.userBySocket.get(client.id);
    if (!user) return { ok: false, error: 'unauthenticated' };
    if (!body.periodId) return { ok: false, error: 'periodId required' };

    if (user.role === 'student') {
      const [row] = await this.db
        .select({ id: periodEnrollments.id })
        .from(periodEnrollments)
        .innerJoin(students, eq(students.id, periodEnrollments.studentId))
        .where(and(eq(students.userId, user.sub), eq(periodEnrollments.periodId, body.periodId)))
        .limit(1);
      if (!row) return { ok: false, error: 'not enrolled in this period' };
    }
    await client.join(`lobby:${body.periodId}`);
    return { ok: true };
  }

  /** Lecturers join their own room; admins may observe any lecturer room. */
  @SubscribeMessage('lecturer.subscribe')
  async subscribeLecturer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { lecturerId?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    const user = this.userBySocket.get(client.id);
    if (!user) return { ok: false, error: 'unauthenticated' };
    if (user.role === 'student') return { ok: false, error: 'forbidden' };

    const lecturerId =
      user.role === 'lecturer' ? await this.lecturerIdFor(user.sub) : body.lecturerId ?? null;
    if (!lecturerId) return { ok: false, error: 'lecturer not found' };
    await client.join(`lecturer:${lecturerId}`);
    return { ok: true };
  }

  /** Granular per-card subscription (thesis:{id}). */
  @SubscribeMessage('thesis.subscribe')
  async subscribeThesis(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { thesisId?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    const user = this.userBySocket.get(client.id);
    if (!user || !body.thesisId) return { ok: false, error: 'bad request' };
    await client.join(`thesis:${body.thesisId}`);
    return { ok: true };
  }

  private async lecturerIdFor(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: lecturers.id })
      .from(lecturers)
      .where(eq(lecturers.userId, userId))
      .limit(1);
    return row?.id ?? null;
  }
}
