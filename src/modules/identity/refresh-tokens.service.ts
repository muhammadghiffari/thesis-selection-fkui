import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { refreshTokens, users } from '../../shared/db/schema.js';
import type { AuthUser } from './auth-user.js';

export const REFRESH_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const TOKEN_BYTES = 48;

export interface IssuedRefreshToken {
  raw: string;
  expiresAt: Date;
}

/**
 * Refresh tokens are opaque random values; only their sha256 hash is stored,
 * so a DB leak cannot mint sessions. Rotation = conditional UPDATE ... RETURNING
 * (revokes the presented token atomically) followed by inserting the successor.
 */
@Injectable()
export class RefreshTokensService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  async issue(userId: string): Promise<IssuedRefreshToken> {
    const raw = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000);
    await this.db.insert(refreshTokens).values({ userId, tokenHash: this.hash(raw), expiresAt });
    return { raw, expiresAt };
  }

  /** Atomically consumes `raw` and stores its replacement. Returns the session's user. */
  async rotate(
    raw: string,
  ): Promise<{ userId: string; role: 'admin' | 'lecturer' | 'student'; next: IssuedRefreshToken }> {
    const [row] = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.tokenHash, this.hash(raw)),
          isNull(refreshTokens.revokedAt),
          sql`${refreshTokens.expiresAt} > now()`,
        ),
      )
      .returning({ userId: refreshTokens.userId });

    if (!row) throw new UnauthorizedException('Invalid or expired refresh token');

    const [user] = await this.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(and(eq(users.id, row.userId), isNull(users.deletedAt)))
      .limit(1);
    if (!user) throw new UnauthorizedException('Account no longer active');

    const next = await this.issue(row.userId);
    return { userId: user.id, role: user.role as AuthUser['role'], next };
  }

  async revoke(raw: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.tokenHash, this.hash(raw)), isNull(refreshTokens.revokedAt)));
  }
}
