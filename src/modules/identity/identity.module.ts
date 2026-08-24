import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { SESSION_ISSUER } from '../../shared/auth/session.port.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { RefreshTokensService } from './refresh-tokens.service.js';
import { StudentEmailService } from './student-email.service.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('app.jwtSecret'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    UsersService,
    AuthService,
    StudentEmailService,
    RefreshTokensService,
    LoginRateLimiter,
    {
      // composition-root adapter: other modules consume the port, not identity
      provide: SESSION_ISSUER,
      inject: [RefreshTokensService],
      useFactory: (sessions: RefreshTokensService) => ({
        issueSession: (userId: string, role: 'admin' | 'lecturer' | 'student') =>
          sessions.issueSession(userId, role),
      }),
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [UsersService, StudentEmailService],
})
export class IdentityModule {}
