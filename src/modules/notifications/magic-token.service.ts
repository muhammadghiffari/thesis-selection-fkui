import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';

export interface MagicLinkPayload {
  sub: string; // users.id
  role: 'student';
  periodId: string;
  jti: string;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function hashFingerprint(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex');
}

/**
 * Signs/verifies the emailed magic-link JWT. The token itself is single-use
 * via server-side state (enrollment row), not via JWT semantics — exp is the
 * absolute safety cap; the interactive TTL is enforced from first open.
 */
@Injectable()
export class MagicTokenService {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  async sign(payload: Omit<MagicLinkPayload, 'role'>, expiresAt: Date): Promise<string> {
    return this.jwt.signAsync({ ...payload, role: 'student' } satisfies MagicLinkPayload, {
      expiresIn: Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    });
  }

  async verify(token: string): Promise<MagicLinkPayload> {
    try {
      const payload = await this.jwt.verifyAsync<MagicLinkPayload>(token);
      if (payload.role !== 'student' || !payload.periodId || !payload.jti) {
        throw new Error('bad payload');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired magic link');
    }
  }

  hash(jti: string): string {
    return hashToken(jti);
  }
}
