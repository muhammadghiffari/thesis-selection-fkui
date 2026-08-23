import { Body, Controller, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from './auth-user.js';
import { Public } from './decorators/public.decorator.js';
import { AuthService } from './auth.service.js';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

function requireUser(req: Request): AuthUser {
  const user = req.user;
  if (!user) throw new UnauthorizedException();
  return user;
}

/** JWT auth guard is registered globally; only login is @Public. */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto): Promise<{ accessToken: string; user: AuthUser }> {
    return this.auth.login(dto.email, dto.password);
  }

  /** Echoes the verified token payload — RBAC smoke target for CI. */
  @Get('me')
  me(@Req() req: Request): AuthUser {
    return requireUser(req);
  }
}
