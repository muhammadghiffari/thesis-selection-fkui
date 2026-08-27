import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export const DATABASE = Symbol('DATABASE');
const PG_POOL = Symbol('PG_POOL');

export function createStandaloneDb(connectionString: string): { db: Database; end: () => Promise<void> } {
  const pool = new Pool({ connectionString, max: 20 });
  return { db: drizzle(pool, { schema }), end: () => pool.end() };
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Pool({ connectionString: config.getOrThrow<string>('app.databaseUrl'), max: 20 }),
    },
    {
      provide: DATABASE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DATABASE],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
