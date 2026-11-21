import { Body, Controller, Get, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser, UserProfile } from './auth-user.js';
import { AuthService, type TokenPair } from './auth.service.js';
import { ForgotPasswordDto, LoginDto, RefreshTokenDto, ResetPasswordDto, StaffDto } from './dto.js';
import { Public } from './decorators/public.decorator.js';
import { Roles } from './decorators/roles.decorator.js';
import { PasswordResetService } from './password-reset.service.js';
import { Throttle } from '../../shared/throttle/throttle.decorator.js';

function requireUser(req: Request): AuthUser {
  const user = req.user;
  if (!user) throw new UnauthorizedException();
  return user;
}

/**
 * Global guards: JwtAuthGuard (opt-out via @Public) then RolesGuard.
 * - No public student self-registration: students are provisioned via admin
 *   flows and authenticate through scheduled magic links (F3+).
 * - refresh/logout authenticate via the body contents, not a JWT.
 * - POST /auth/staff is admin-only (staff accounts are never self-serve).
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PasswordResetService) private readonly reset: PasswordResetService,
  ) {}

  @Public()
  @Throttle({ limit: 60, ttlSec: 60, keyBy: 'ip' })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<TokenPair> {
    return this.auth.login(dto.email, dto.password, req.ip ?? 'unknown');
  }

  @Public()
  @Throttle({ limit: 120, ttlSec: 60, keyBy: 'ip' })
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Throttle({ limit: 60, ttlSec: 60, keyBy: 'ip' })
  @Post('logout')
  logout(@Body() dto: RefreshTokenDto): Promise<{ success: true }> {
    return this.auth.logout(dto.refreshToken);
  }

  @Public()
  @Throttle({ limit: 10, ttlSec: 60, keyBy: 'ip' })
  @Post('forgot-password')
  forgot(@Body() dto: ForgotPasswordDto, @Req() req: Request): Promise<{ sent: true }> {
    return this.reset.requestReset(dto.email, req.ip ?? 'unknown');
  }

  @Public()
  @Throttle({ limit: 10, ttlSec: 60, keyBy: 'ip' })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request): Promise<{ reset: true }> {
    return this.reset.resetPassword(dto.token, dto.password, req.ip ?? 'unknown');
  }

  @Roles('admin')
  @Post('staff')
  createStaff(@Body() dto: StaffDto): Promise<UserProfile> {
    return this.auth.createStaff(dto);
  }

  /** Current user profile — resolved from DB so revoked/deleted users fail fast. */
  @Get('me')
  async me(@Req() req: Request): Promise<UserProfile> {
    const user = requireUser(req);
    const profile = await this.auth.profile(user.sub);
    if (!profile) throw new UnauthorizedException('Account no longer active');
    return profile;
  }
}
