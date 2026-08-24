import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { RedisContainer } from '@testcontainers/redis';
import * as argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import type { Server } from 'node:http';
import type { Database } from '../../src/shared/db/db.module.js';

/**
 * Boots the real Nest application against Testcontainers pg/redis.
 * Env MUST be set before importing AppModule — config factories read
 * process.env at module-init time (hence the dynamic import below).
 */
export interface TestApp {
  url: string;
  db: Database;
  /** Direct redis for heartbeat/rate-limit assertions. */
  redisUrl: string;
  close: () => Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  const { startPostgres } = await import('./spin-postgres.js');

  const pg = await startPostgres();
  const redis: StartedRedisContainer = await new RedisContainer('redis:7-alpine').start();

  process.env.DATABASE_URL = pg.container.getConnectionUri();
  process.env.REDIS_URL = redis.getConnectionUrl();
  process.env.JWT_SECRET ??= 'integration-test-secret';
  delete process.env.PORT;

  // Only NOW may app.module.js load — its config factories read process.env at import time.
  const { AppModule } = await import('../../src/app.module.js');

  const app: INestApplication = await NestFactory.create(AppModule, { bufferLogs: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const server: Server = await app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no listen address');

  return {
    url: `http://localhost:${address.port}`,
    db: pg.db,
    redisUrl: redis.getConnectionUrl(),
    close: async () => {
      await app.close();
      await pg.end();
      await redis.stop().catch(() => undefined);
    },
  };
}

const ARGON2 = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** Inserts a staff user directly (bypasses HTTP) for role-guard scenarios. */
export async function seedStaff(
  db: Database,
  email: string,
  password: string,
  role: 'admin' | 'lecturer',
): Promise<void> {
  const hash = await argon2.hash(password, ARGON2);
  await db.execute(
    sql`INSERT INTO users (email, password_hash, role) VALUES (${email}, ${hash}, ${role})`,
  );
}
