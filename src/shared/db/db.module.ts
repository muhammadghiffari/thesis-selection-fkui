import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export const DATABASE = Symbol('DATABASE');

/** Standalone pool+db for CLIs/tests that own their lifecycle. */
export function createStandaloneDb(connectionString: string): { db: Database; end: () => Promise<void> } {
  const pool = new Pool({ connectionString, max: 20 });
  return { db: drizzle(pool, { schema }), end: () => pool.end() };
}

/** Nest variant — ponytail: pool handle dropped; graceful DB close lands with the realtime module (F6). */
export function createDatabase(connectionString: string): Database {
  return createStandaloneDb(connectionString).db;
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createDatabase(config.getOrThrow<string>('app.databaseUrl')),
    },
  ],
  exports: [DATABASE],
})
export class DbModule {}
