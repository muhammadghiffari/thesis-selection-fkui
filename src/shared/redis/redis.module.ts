import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

export function createRedisConnection(url: string, forQueues = false): Redis {
  return new Redis(url, {
    lazyConnect: !forQueues,
    maxRetriesPerRequest: forQueues ? null : undefined,
  });
}

let _redisRef: Redis | null = null;

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        _redisRef = createRedisConnection(config.getOrThrow<string>('app.redisUrl'));
        return _redisRef;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await _redisRef?.quit().catch(() => _redisRef?.disconnect());
  }
}

