import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { AuditService } from '../../shared/audit/audit.service.js';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { passwordResetTokens, refreshTokens, users } from '../../shared/db/schema.js';
import { EMAIL_PROVIDER } from '../../shared/notifications/notifications-infra.module.js';
import type { EmailProvider } from '../../shared/notifications/email-provider.js';
import { REDIS } from '../../shared/redis/redis.module.js';
import { UsersService } from './users.service.js';

/**
 * Staff password reset (OWASP A07 / ASVS 2.1.5).
 * - Always responds generically (`{ sent: true }`) whether or not the email
 *   exists → no user enumeration.
 * - Token is 32 random bytes (base64url); only sha256 hash is stored; 30-min
 *   TTL; single-use (consumed atomically via used_at guard); superseded
 *   tokens are invalidated on a new request.
 * - On success: password rotated (argon2id), all refresh tokens revoked,
 *   audit entry written. Failure paths are rate-limited per email+IP and
 *   logged as security events.
 */
const TTL_MS = 30 * 60 * 1000;
const PER_EMAIL_LIMIT = 3;
const PER_IP_LIMIT = 10;
const WINDOW_SEC = 60 * 60;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async requestReset(email: string, ip: string): Promise<{ sent: true }> {
    const normalized = email.toLowerCase();
    // Silent drop over the budget — still generic so limits don't leak existence.
    if (await this.overLimit(normalized, ip)) {
      this.logger.warn({ email: normalized, ip }, 'password-reset: silently dropped (over limit)');
      return { sent: true };
    }
    await this.recordAttempt(normalized, ip);

    const [row] = await this.db
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(and(eq(users.email, normalized), isNull(users.deletedAt)))
      .limit(1);

    // Staff only — students authenticate via magic links (no password reset).
    if (!row || (row.role !== 'admin' && row.role !== 'lecturer')) {
      return { sent: true };
    }

    // Invalidate any outstanding tokens for this user.
    await this.db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.userId, row.id),
          isNull(passwordResetTokens.usedAt),
          sql`${passwordResetTokens.expiresAt} > now()`,
        ),
      );

    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TTL_MS);
    await this.db.insert(passwordResetTokens).values({
      userId: row.id,
      tokenHash: hashToken(raw),
      expiresAt,
    });

    const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '');
    const link = appUrl ? `${appUrl}/reset-password?token=${raw}` : `/reset-password?token=${raw}`;
    try {
      await this.email.send({
        to: row.email,
        subject: 'Reset your thesis selection password',
        body: `<p>We received a password reset request. The link expires in 30 minutes and can be used once.</p><p><a href="${link}">Reset password</a></p><p>If you did not request this, ignore this email.</p>`,
      });
      this.logger.log({ userId: row.id }, 'password-reset: email queued');
    } catch (err) {
      // Do NOT rethrow: a real staff email with a failing provider would then
      // return 500 while an unknown email returns 200 — user enumeration.
      // Always keep the generic response; the failure stays in logs/audit.
      this.logger.error({ err, userId: row.id }, 'password-reset: email delivery failed (generic response kept)');
    }

    await this.audit
      .log(null, 'auth.password_reset.requested', 'user', row.id, { ip })
      .catch(() => undefined);
    return { sent: true };
  }

  async resetPassword(rawToken: string, newPassword: string, ip: string): Promise<{ reset: true }> {
    const hash = hashToken(rawToken);
    // Atomically consume-then-verify: mark used ONLY when still valid.
    const [consumed] = await this.db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hash),
          isNull(passwordResetTokens.usedAt),
          sql`${passwordResetTokens.expiresAt} > now()`,
        ),
      )
      .returning({ userId: passwordResetTokens.userId });

    if (!consumed) {
      this.logger.warn({ ip }, 'password-reset: invalid/expired/consumed token presented');
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const [user] = await this.db
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(and(eq(users.id, consumed.userId), isNull(users.deletedAt)))
      .limit(1);
    if (!user) throw new UnauthorizedException('Invalid or expired reset token');

    const passwordHash = await this.users.hashPassword(newPassword);
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

    // Revoke every outstanding session for the account.
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));

    this.logger.log({ userId: user.id, ip }, 'password-reset: password rotated, sessions revoked');
    await this.audit
      .log(
        { id: user.id, role: user.role as 'admin' | 'lecturer' | 'student' },
        'auth.password_reset.completed',
        'user',
        user.id,
        { ip },
      )
      .catch(() => undefined);
    return { reset: true };
  }

  private async overLimit(email: string, ip: string): Promise<boolean> {
    const [e, i] = await Promise.all([
      this.redis.get(`reset:email:${email}`),
      this.redis.get(`reset:ip:${ip}`),
    ]);
    return Number(e ?? 0) >= PER_EMAIL_LIMIT || Number(i ?? 0) >= PER_IP_LIMIT;
  }

  private async recordAttempt(email: string, ip: string): Promise<void> {
    for (const key of [`reset:email:${email}`, `reset:ip:${ip}`]) {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, WINDOW_SEC);
    }
  }
}
