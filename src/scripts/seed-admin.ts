import 'dotenv/config';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createStandaloneDb, type Database } from '../shared/db/db.module.js';
import { users } from '../shared/db/schema.js';

/** Idempotent bootstrap admin: npm run seed:admin -- <email> <password> */
async function seedAdmin(db: Database, email: string, password: string): Promise<void> {
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    await db.update(users).set({ passwordHash, role: 'admin', deletedAt: null }).where(eq(users.email, email));
    console.log(`admin updated: ${email}`);
    return;
  }
  await db.insert(users).values({ email, role: 'admin', passwordHash });
  console.log(`admin created: ${email}`);
}

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2);
  if (!email || !password || password.length < 8) {
    console.error('usage: npm run seed:admin -- <email> <password(min 8 chars)>');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const { db, end } = createStandaloneDb(url);
  try {
    await seedAdmin(db, email.toLowerCase(), password);
  } finally {
    await end();
  }
}

void main();
