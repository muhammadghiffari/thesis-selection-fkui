import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Database } from '../../src/shared/db/db.module.js';
import { createStandaloneDb } from '../../src/shared/db/db.module.js';
import { runMigrations } from '../../src/shared/db/migrate.js';

export interface PgFixture {
  container: StartedPostgreSqlContainer;
  db: Database;
  end: () => Promise<void>;
}

/** Starts pgvector-enabled Postgres and applies all Drizzle migrations cleanly. */
export async function startPostgres(): Promise<PgFixture> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('thesis_selection_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const handle = createStandaloneDb(container.getConnectionUri());
  await runMigrations(handle.db); // must run clean — DoD requirement
  return { container, db: handle.db, end: handle.end };
}
