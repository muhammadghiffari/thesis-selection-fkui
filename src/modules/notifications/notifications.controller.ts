import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { IsIn, IsString, IsUUID, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../../shared/audit/audit.service.js';
import { ConflictException, GoneException, UnauthorizedException } from '@nestjs/common';
import type { AuthUser } from '../identity/auth-user.js';
import { Public } from '../identity/decorators/public.decorator.js';
import { Roles } from '../identity/decorators/roles.decorator.js';
import { NotificationsService } from './notifications.service.js';
import { STAGE_KEYS, type StageKey } from './stage-definitions.js';

export class MagicTokenDto {
  @IsString() @MinLength(20) token!: string;
  /** Stable device fingerprint generated client-side. */
  @IsString() @MinLength(8) fingerprint!: string;
}

export class RunStageDto {
  @IsIn(STAGE_KEYS) stage!: StageKey;
}

export class ResendDto {
  @IsUUID() periodId!: string;
}

function requireUser(req: Request): AuthUser {
  const user = req.user;
  if (!user) throw new UnauthorizedException();
  return user;
}

export function toHttpError(err: unknown): never {
  const status = (err as { status?: number }).status;
  if (status === 410) throw new GoneException((err as Error).message);
  if (status === 409) throw new ConflictException((err as Error).message);
  if (status === 401) throw new UnauthorizedException((err as Error).message);
  throw err as Error;
}

/** Student-facing magic-link exchange. Public — the token is the credential. */
@Public()
@Controller('magic')
export class MagicController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Post('open')
  async open(
    @Body() dto: MagicTokenDto,
  ): Promise<{ expiresAt: string; periodId: string }> {
    try {
      return await this.notifications.open(dto.token, dto.fingerprint);
    } catch (err) {
      toHttpError(err);
    }
  }

  @Post('claim')
  async claim(
    @Body() dto: MagicTokenDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      return await this.notifications.claim(dto.token, dto.fingerprint);
    } catch (err) {
      toHttpError(err);
    }
  }
}

/** Delivery tracking + manual ops triggers. Admin only. */
@Roles('admin')
@Controller('admin')
export class DeliveriesController {
  constructor(
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('periods/:id/enrollments')
  dashboard(@Param('id') periodId: string) {
    return this.notifications.dashboard(periodId);
  }

  /** Ops trigger for a delivery stage (tests/scheduler backstop); exactly-once guards apply. */
  @Post('periods/:id/run-stage')
  async runStage(
    @Req() req: Request,
    @Param('id') periodId: string,
    @Body() dto: RunStageDto,
  ): Promise<{ sent: number }> {
    const user = requireUser(req);
    const result = await this.notifications.runStage(periodId, dto.stage);
    await this.audit.log({ id: user.sub, role: user.role }, 'notifications.run_stage', 'selection_period', periodId, {
      stage: dto.stage,
      sent: result.sent,
    });
    return result;
  }

  /** Individual magic-link resend with audit trail. */
  @Post('students/:studentId/resend-link')
  async resend(
    @Req() req: Request,
    @Param('studentId') studentId: string,
    @Body() dto: ResendDto,
  ): Promise<{ delivered: true }> {
    const user = requireUser(req);
    try {
      const result = await this.notifications.resend(studentId, dto.periodId);
      await this.audit.log({ id: user.sub, role: user.role }, 'magic_link.resend', 'student', studentId, {
        periodId: dto.periodId,
      });
      return result;
    } catch (err) {
      toHttpError(err);
    }
  }
}
