import type Redis from 'ioredis';

export interface Throttle {
  assertAllowed(key: string): Promise<void>;
  record(key: string): Promise<void>;
}

/**
 * Generic Redis INCR/EXPIRE throttle (F5 pattern, generalized).
 * Throws HttpException(429) when the per-key budget is exhausted.
 */
export function createThrottle(
  redis: Redis,
  prefix: string,
  maxPerWindow: number,
  windowSec: number,
): Throttle {
  const keyOf = (key: string): string => `${prefix}:${key}`;
  return {
    async assertAllowed(key: string): Promise<void> {
      const { HttpException } = await import('@nestjs/common');
      const count = await redis.get(keyOf(key));
      if (count !== null && Number(count) >= maxPerWindow) {
        throw new HttpException('Too many actions — slow down.', 429);
      }
    },
    async record(key: string): Promise<void> {
      const key2 = keyOf(key);
      const count = await redis.incr(key2);
      if (count === 1) await redis.expire(key2, windowSec);
    },
  };
}
