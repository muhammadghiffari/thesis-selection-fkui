import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthIndicatorFunction,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import type Redis from 'ioredis';
import { sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../db/db.module.js';
import { REDIS } from '../redis/redis.module.js';
import { Public } from '../../modules/identity/decorators/public.decorator.js';

function up(key: string): HealthIndicatorResult {
  return { [key]: { status: 'up' } };
}

function down(key: string): HealthIndicatorResult {
  // status:'down' makes Terminus answer 503 with overall status "error"
  return { [key]: { status: 'down' } };
}

@Controller('health')
export class HealthController {
  // NOTE: explicit @Inject keeps DI working under esbuild-based runners
  // (vitest) where decorator metadata is not emitted.
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  check(): Promise<{ status: string }> {
    const postgres: HealthIndicatorFunction = async () => {
      try {
        await this.db.execute(sql`select 1`);
        return up('database');
      } catch {
        return down('database');
      }
    };

    const redisPing: HealthIndicatorFunction = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // .catch keeps the losing branch settled — a late rejection must
        // never escape the race as an unhandled one.
        const pong = await Promise.race([
          this.redis.ping().catch(() => 'ERR'),
          new Promise<string>((_, reject) => {
            timer = setTimeout(() => void reject(new Error('redis ping timeout')), 2000);
          }),
        ]);
        return pong === 'PONG' ? up('redis') : down('redis');
      } catch {
        return down('redis');
      } finally {
        clearTimeout(timer);
      }
    };

    return this.health.check([postgres, redisPing]);
  }
}
