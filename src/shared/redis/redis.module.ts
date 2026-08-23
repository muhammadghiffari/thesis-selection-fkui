import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

/**
 * BullMQ needs blocking-safe connections (maxRetriesPerRequest: null);
 * API-side clients connect lazily so health checks drive readiness.
 * ponytail: explicit quit-on-shutdown arrives with the realtime module
 * (F6), which owns connection lifecycles.
 */
export function createRedisConnection(url: string, forQueues = false): Redis {
  return new Redis(url, {
    lazyConnect: !forQueues,
    maxRetriesPerRequest: forQueues ? null : undefined,
  });
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        createRedisConnection(config.getOrThrow<string>('app.redisUrl')),
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
