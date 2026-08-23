import { HttpException, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../shared/redis/redis.module.js';

export const MAX_LOGIN_FAILURES = 5;
const WINDOW_SEC = 15 * 60;

/** Redis-backed login throttling: MAX_LOGIN_FAILURES failures per email+IP per 15 min. */
@Injectable()
export class LoginRateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(email: string, ip: string): string {
    return `rl:login:${email.toLowerCase()}:${ip}`;
  }

  /** Throws 429 when the client is over the failure budget. */
  async assertAllowed(email: string, ip: string): Promise<void> {
    const count = await this.redis.get(this.key(email, ip));
    if (count !== null && Number(count) >= MAX_LOGIN_FAILURES) {
      throw new HttpException(
        'Too many failed login attempts. Try again in 15 minutes.',
        429,
      );
    }
  }

  async recordFailure(email: string, ip: string): Promise<void> {
    const key = this.key(email, ip);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, WINDOW_SEC);
  }

  async reset(email: string, ip: string): Promise<void> {
    await this.redis.del(this.key(email, ip));
  }
}
