import { Body, Controller, Get, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser, UserProfile } from './auth-user.js';
import { AuthService, type TokenPair } from './auth.service.js';
import { LoginDto, RefreshTokenDto, RegisterDto, StaffDto } from './dto.js';
import { Public } from './decorators/public.decorator.js';
import { Roles } from './decorators/roles.decorator.js';

function requireUser(req: Request): AuthUser {
  const user = req.user;
  if (!user) throw new UnauthorizedException();
  return user;
}

/**
 * Global guards: JwtAuthGuard (opt-out via @Public) then RolesGuard.
 * - register/refresh/logout authenticate via the body contents, not a JWT.
 * - POST /auth/staff is admin-only (staff accounts are never self-serve).
 */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<TokenPair> {
    return this.auth.registerStudent(dto.email, dto.password);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<TokenPair> {
    return this.auth.login(dto.email, dto.password, req.ip ?? 'unknown');
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  logout(@Body() dto: RefreshTokenDto): Promise<{ success: true }> {
    return this.auth.logout(dto.refreshToken);
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
