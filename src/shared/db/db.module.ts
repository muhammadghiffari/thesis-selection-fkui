import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export const DATABASE = Symbol('DATABASE');

/** Bounded pool size: DB_POOL_MAX (integer 1..50, default 20). Neon free's
 * pooler tolerates ~4 pools (API + 3 workers) at this cap. */
export function dbPoolMax(): number {
  const raw = Number(process.env.DB_POOL_MAX ?? 20);
  if (!Number.isInteger(raw) || raw < 1) return 20;
  return Math.min(raw, 50);
}

/** Standalone pool+db for CLIs/tests that own their lifecycle. */
export function createStandaloneDb(connectionString: string): { db: Database; end: () => Promise<void> } {
  const pool = new Pool({ connectionString, max: dbPoolMax() });
  return { db: drizzle(pool, { schema }), end: () => pool.end() };
}

/**
 * Module-level reference captured by the factory so we can close the pool
 * on shutdown WITHOUT @Inject parameter decorators (which break tsx/esbuild
 * used by migrate-cli and seed scripts that import createStandaloneDb).
 */
let _poolRef: Pool | null = null;

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        _poolRef = new Pool({ connectionString: config.getOrThrow<string>('app.databaseUrl'), max: dbPoolMax() });
        return drizzle(_poolRef, { schema });
      },
    },
  ],
  exports: [DATABASE],
})
export class DbModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await _poolRef?.end();
  }
}
