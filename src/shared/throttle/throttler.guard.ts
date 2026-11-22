import { HttpException, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module.js';
import { THROTTLE_KEY, type ThrottleOptions } from './throttle.decorator.js';

/**
 * Global Redis-backed rate limiting (OWASP A07 / A06 abuse control).
 * - Default: 2000 req/min/IP (generous so campus NATs + 300-user war room
 *   never trip; the load balancer / CDN in front enforces the strict cap).
 * - @Throttle on sensitive routes: auth 60/min/IP, magic 300/min/IP,
 *   validate/export 30/min/user, war bootstrap routes rely on the
 *   per-user WarRateLimiter instead of IP (NAT-safe).
 * Returns 429 with Retry-After. LB should mirror these caps at edge.
 */
export const DEFAULT_THROTTLE: ThrottleOptions = { limit: 2000, ttlSec: 60 };

@Injectable()
export class ThrottlerGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const opts =
      this.reflector.getAllAndOverride<ThrottleOptions>(THROTTLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_THROTTLE;
    if (!Number.isFinite(opts.limit) || opts.limit > 1_000_000) return true;

    const req = context.switchToHttp().getRequest<{
      ip?: string;
      user?: { sub?: string };
    }>();
    const ip = req.ip ?? 'unknown';
    const userId = req.user?.sub ?? null;
    const keyBy = opts.keyBy ?? 'ip';
    let scope = ip;
    if (keyBy === 'user' && userId) scope = `u:${userId}`;
    if (keyBy === 'ip-user') scope = `${ip}:${userId ?? 'anon'}`;

    // Per-route buckets: login and password-reset must not share a counter.
    const handler = context.getHandler() as { name?: string } | undefined;
    const route = handler?.name ?? 'unknown';
    const key = `throttle:${route}:${scope}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, opts.ttlSec);
    if (count > opts.limit) {
      const ttl = await this.redis.ttl(key).catch(() => opts.ttlSec);
      const ex = new HttpException('Too many requests — slow down. Try again shortly.', 429);
      (ex as unknown as { response?: unknown }).response = {
        statusCode: 429,
        message: 'Too many requests — slow down. Try again shortly.',
        retryAfter: Math.max(ttl, 1),
      };
      throw ex;
    }
    return true;
  }
}

