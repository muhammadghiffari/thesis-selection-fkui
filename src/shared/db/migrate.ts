import { resolve } from 'node:path';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './db.module.js';

/**
 * ponytail: migrations folder resolved from cwd (repo root in dev,
 * WORKDIR /app in Docker). If tests ever run from another cwd, pass
 * an explicit folder instead of guessing.
 */
export function migrationsFolder(): string {
  return resolve(process.cwd(), 'drizzle');
}

export async function runMigrations(db: Database): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder: migrationsFolder() });
}
