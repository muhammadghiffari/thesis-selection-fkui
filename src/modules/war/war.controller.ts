import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, ConflictException, GoneException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../identity/auth-user.js';
import { Roles } from '../identity/decorators/roles.decorator.js';
import { WarService } from './war.service.js';

export class ClaimDto {
  @IsUUID() periodId!: string;
  @IsUUID() thesisId!: string;
  /** Client-generated unique key — retries return the stored outcome. */
  @IsString() @MinLength(8) idempotencyKey!: string;
}

export class PeriodQueryDto {
  @IsUUID() periodId!: string;
}

export class ReorderDto {
  @IsUUID() periodId!: string;
  @IsArray() @IsString({ each: true }) order!: string[];
}

export class HeartbeatDto {
  @IsUUID() periodId!: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() tabVisible?: boolean;
}

/** Maps service-level {status} domain errors onto HTTP semantics. */
function toHttpError(err: unknown): never {
  const status = (err as { status?: number }).status;
  if (status === 410) throw new GoneException((err as Error).message);
  if (status === 409) throw new ConflictException((err as Error).message);
  throw err as Error;
}

function requireUser(req: Request): AuthUser {
  const user = req.user;
  if (!user) throw new Error('unauthenticated');
  return user;
}

/**
 * War room. Student-only; every route is pre-opens_at guarded via
 * WarService.assertWarOpen (secrecy suite pins this).
 */
@Roles('student')
@Controller('war')
export class WarController {
  constructor(@Inject(WarService) private readonly war: WarService) {}

  @Get('catalog')
  catalog(@Req() req: Request, @Query() q: PeriodQueryDto) {
    const user = requireUser(req);
    return this.war.catalog(user.sub, q.periodId);
  }

  /** Tap card → instant lock (no modal). Losers get structured loss + fallback. */
  @Post('claims')
  claim(@Req() req: Request, @Body() dto: ClaimDto) {
    const user = requireUser(req);
    return this.war.claim(user, dto);
  }

  @Post('claims/:id/confirm')
  async confirm(@Req() req: Request, @Param('id') id: string) {
    const user = requireUser(req);
    try {
      return await this.war.confirm(user, id);
    } catch (err) {
      toHttpError(err);
    }
  }

  @Post('claims/:id/release')
  release(@Req() req: Request, @Param('id') id: string) {
    const user = requireUser(req);
    return this.war.release(user, id);
  }

  /** Undo inside the configured window post-confirm; later → 410 Gone. */
  @Post('claims/:id/undo')
  async undo(@Req() req: Request, @Param('id') id: string) {
    const user = requireUser(req);
    try {
      return await this.war.undo(user, id);
    } catch (err) {
      toHttpError(err);
    }
  }

  /** Priority reorder (1..3) in one transaction. */
  @Patch('selections/order')
  reorder(@Req() req: Request, @Body() dto: ReorderDto) {
    const user = requireUser(req);
    return this.war.reorder(user, dto.periodId, dto.order);
  }

  @Get('receipt')
  receipt(@Req() req: Request, @Query() q: PeriodQueryDto) {
    const user = requireUser(req);
    return this.war.receipt(user.sub, q.periodId);
  }

  /** Lobby-tab liveness for auto-war arming (Redis TTL key). */
  @Post('heartbeat')
  heartbeat(@Req() req: Request, @Body() dto: HeartbeatDto) {
    const user = requireUser(req);
    return this.war.heartbeat(user.sub, dto.periodId);
  }
}
