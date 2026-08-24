import { HttpException, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../shared/redis/redis.module.js';

export const MAX_CLAIMS_PER_WINDOW = 30;
const WINDOW_SEC = 60;

/** Per-student tap throttle for the war (Redis INCR/EXPIRE). */
@Injectable()
export class WarRateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(userId: string): string {
    return `rl:war:${userId}`;
  }

  async assertAllowed(userId: string): Promise<void> {
    const count = await this.redis.get(this.key(userId));
    if (count !== null && Number(count) >= MAX_CLAIMS_PER_WINDOW) {
      throw new HttpException('Too many actions — slow down.', 429);
    }
  }

  async recordAction(userId: string): Promise<void> {
    const key = this.key(userId);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, WINDOW_SEC);
  }
}
