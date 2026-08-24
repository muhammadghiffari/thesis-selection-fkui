import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../../shared/audit/audit.service.js';
import type { AuthUser } from '../identity/auth-user.js';
import { Roles } from '../identity/decorators/roles.decorator.js';
import { RealtimeService } from './realtime.service.js';

export class BroadcastDto {
  @IsString() @MinLength(3) @MaxLength(280) message!: string;
}

function requireUser(req: Request): AuthUser {
  const user = req.user;
  if (!user) throw new Error('unauthenticated');
  return user;
}

/** Global broadcast banner — admin only, audited. */
@Roles('admin')
@Controller('admin/broadcast')
export class BroadcastController {
  constructor(
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post()
  async broadcast(@Req() req: Request, @Body() dto: BroadcastDto): Promise<{ sent: true }> {
    const user = requireUser(req);
    await this.realtime.publish({
      event: 'banner',
      payload: { message: dto.message, at: new Date().toISOString(), by: user.sub },
    });
    await this.audit.log({ id: user.sub, role: user.role }, 'admin.broadcast', 'broadcast', null, {
      message: dto.message,
    });
    return { sent: true };
  }
}
