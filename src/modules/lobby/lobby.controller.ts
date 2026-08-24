import { Body, Controller, Get, Inject, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../identity/auth-user.js';
import { Roles } from '../identity/decorators/roles.decorator.js';
import { LobbyService, type LobbyView } from './lobby.service.js';

export class LobbyQueryDto {
  @IsUUID() periodId!: string;
}

export class PreferenceDto {
  @IsUUID() periodId!: string;
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
}

export class AutoWarDto {
  @IsUUID() periodId!: string;
  @Type(() => Boolean) @IsBoolean() enabled!: boolean;
  /** Must be true when enabling — the UI's pre-confirm checkbox. */
  @IsOptional() @Type(() => Boolean) @IsBoolean() consent?: boolean;
}

function requireUser(req: Request): AuthUser {
  const user = req.user;
  if (!user) throw new UnauthorizedException();
  return user;
}

/**
 * Pre-war lobby: server-authoritative countdown inputs, AI preference
 * capture, auto-war opt-in. Student-only by design.
 */
@Roles('student')
@Controller('lobby')
export class LobbyController {
  constructor(@Inject(LobbyService) private readonly lobby: LobbyService) {}

  /** Countdown inputs derive from ONE server timestamp (client computes skew). */
  @Get()
  view(@Req() req: Request, @Query() q: LobbyQueryDto): Promise<LobbyView> {
    return this.lobby.view(requireUser(req).sub, q.periodId);
  }

  @Get('preferences')
  preference(@Req() req: Request, @Query() q: LobbyQueryDto): Promise<{ text: string; updatedAt: string } | null> {
    return this.lobby.preference(requireUser(req).sub, q.periodId);
  }

  /** Free-text research interests → embedding (used by F5 fallback matching). */
  @Post('preferences')
  savePreference(@Req() req: Request, @Body() dto: PreferenceDto): Promise<{ saved: true }> {
    return this.lobby.savePreference(requireUser(req).sub, dto.periodId, dto.text);
  }

  @Post('auto-war')
  autoWar(
    @Req() req: Request,
    @Body() dto: AutoWarDto,
  ): Promise<{ enabled: boolean; consentedAt: string | null }> {
    return this.lobby.setAutoWar(requireUser(req).sub, dto.periodId, {
      enabled: dto.enabled,
      consent: dto.consent,
    });
  }
}
