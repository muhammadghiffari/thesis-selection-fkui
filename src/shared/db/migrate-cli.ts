import 'dotenv/config';
import { createStandaloneDb } from './db.module.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const { db, end } = createStandaloneDb(url);
  try {
    await runMigrations(db);
    console.log('Migrations applied');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await end();
  }
}

void main();
