import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import Redis from 'ioredis';
import { createThrottle } from '../../shared/throttle/throttle.js';
import { Roles } from '../identity/decorators/roles.decorator.js';
import type { AuthUser } from '../identity/auth-user.js';
import { REDIS } from '../../shared/redis/redis.module.js';
import {
  ChatDto,
  CreateTicketDto,
  ResolveTicketDto,
} from './support.dto.js';
import { SupportService } from './support.service.js';

function getUser(req: Request): AuthUser {
  return (req as unknown as { user: AuthUser }).user;
}

// ─────────────────────────────────────────────────────────────────────────────
// Student-facing endpoints
// ─────────────────────────────────────────────────────────────────────────────

@Controller('support')
@Roles('student')
export class SupportController {
  private readonly chatThrottle;
  private readonly resendThrottle;

  constructor(
    @Inject(SupportService) private readonly support: SupportService,
    @Inject(REDIS) redis: Redis,
  ) {
    // 20 chat messages per minute per student
    this.chatThrottle = createThrottle(redis, 'support:chat', 20, 60);
    // 1 resend per 5 minutes per student
    this.resendThrottle = createThrottle(redis, 'support:resend', 1, 300);
  }

  /** RAG-backed chat — 20 req/min rate limit */
  @Post('chat')
  @HttpCode(200)
  async chat(@Body() body: ChatDto, @Req() req: Request) {
    const actor = getUser(req);
    await this.chatThrottle.assertAllowed(actor.sub);

    const result = await this.support.chat(body.message, body.history ?? [], actor);

    await this.chatThrottle.record(actor.sub);
    return result;
  }

  /** Self-service: check schedule & selection status (never leaks titles) */
  @Post('actions/check-status')
  @HttpCode(200)
  async checkStatus(@Req() req: Request) {
    const actor = getUser(req);
    return this.support.checkStatus(actor);
  }

  /** Self-service: resend magic link — 1 per 5 min */
  @Post('actions/resend-magic-link')
  @HttpCode(200)
  async resendMagicLink(@Req() req: Request) {
    const actor = getUser(req);
    await this.resendThrottle.assertAllowed(actor.sub);
    const result = await this.support.resendMagicLink(actor);
    await this.resendThrottle.record(actor.sub);
    return result;
  }

  /** Self-service: static swap guide */
  @Get('actions/swap-guide')
  getSwapGuide() {
    return this.support.getSwapGuide();
  }

  /** Create escalation ticket */
  @Post('tickets')
  @HttpCode(201)
  async createTicket(@Body() body: CreateTicketDto, @Req() req: Request) {
    const actor = getUser(req);
    return this.support.createTicket(actor, {
      subject: body.subject,
      initialMessage: body.initialMessage,
      channel: body.channel ?? 'human',
      context: body.context,
    });
  }

  /** WhatsApp deep-link with prefilled context */
  @Get('tickets/whatsapp-link')
  async getWhatsAppLink(@Req() req: Request) {
    const actor = getUser(req);
    return this.support.getWhatsAppLink(actor);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin-facing endpoints
// ─────────────────────────────────────────────────────────────────────────────

@Controller('admin/support')
@Roles('admin')
export class AdminSupportController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  /** List tickets with optional status/channel filters */
  @Get('tickets')
  async listTickets(
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize = 20,
  ) {
    return this.support.listTickets({ status, channel, page, pageSize });
  }

  /** Resolve ticket — mandatory note, audit-logged */
  @Patch('tickets/:id/resolve')
  async resolveTicket(
    @Param('id') id: string,
    @Body() body: ResolveTicketDto,
    @Req() req: Request,
  ) {
    const actor = getUser(req);
    return this.support.resolveTicket(id, body.note, { id: actor.sub, role: 'admin' });
  }
}
