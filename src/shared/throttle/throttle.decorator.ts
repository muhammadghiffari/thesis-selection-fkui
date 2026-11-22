import { SetMetadata } from '@nestjs/common';

export const THROTTLE_KEY = 'throttle';

export interface ThrottleOptions {
  limit: number;
  ttlSec: number;
  /** 'ip' (per IP), 'user' (per authenticated sub), or 'ip-user' */
  keyBy?: 'ip' | 'user' | 'ip-user';
}

/** Per-route Redis rate limit. Falls back to the global default when absent. */
export const Throttle = (opts: ThrottleOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(THROTTLE_KEY, opts);

/** Skip the global throttler (health probes, realtime handshake internals). */
export const SkipThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(THROTTLE_KEY, { limit: Number.MAX_SAFE_INTEGER, ttlSec: 60 });
