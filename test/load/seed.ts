import { sql } from 'drizzle-orm';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createStandaloneDb } from '../../src/shared/db/db.module.js';
import { JwtService } from '@nestjs/jwt';

async function run() {
  const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/thesis_selection';
  const handle = createStandaloneDb(dbUrl);
  const db = handle.db;
  
  const jwt = new JwtService({ secret: process.env.JWT_SECRET || 'dev-secret' });

  // 1. Create a period opening in 10 seconds
  const periodId = crypto.randomUUID();
  const opensAt = new Date(Date.now() + 10000);
  
  await db.execute(sql`
    INSERT INTO selection_periods (id, name, status, opens_at, settings)
    VALUES (${periodId}, 'Load Test Period', 'scheduled', ${opensAt.toISOString()}, '{"required_selections":3}')
  `);

  // 2. Create 100 thesis titles
  const thesisIds: string[] = [];
  for(let i=0; i<100; i++) {
    const tId = crypto.randomUUID();
    thesisIds.push(tId);
    await db.execute(sql`
      INSERT INTO theses (id, period_id, topic, title, quota, supervisor_id)
      VALUES (${tId}, ${periodId}, 'Load Test Topic', 'Load Test Title ' || ${i}, 1, NULL)
    `);
  }

  // 3. Create 300 students and enrollments, and generate JWTs
  const users = [];
  for(let i=0; i<300; i++) {
    const uId = crypto.randomUUID();
    const sId = crypto.randomUUID();
    
    await db.execute(sql`
      INSERT INTO users (id, email, role)
      VALUES (${uId}, 'student' || ${i} || '@ui.ac.id', 'student')
    `);
    
    await db.execute(sql`
      INSERT INTO students (id, user_id, npm, full_name)
      VALUES (${sId}, ${uId}, '123000' || ${i}, 'Load Test Student ' || ${i})
    `);
    
    await db.execute(sql`
      INSERT INTO period_enrollments (period_id, student_id)
      VALUES (${periodId}, ${sId})
    `);
    
    const token = await jwt.signAsync({ sub: uId, role: 'student' });
    users.push({ token, periodId });
  }

  fs.writeFileSync('test/load/data.json', JSON.stringify({
    periodId,
    thesisIds,
    users
  }, null, 2));

  console.log('Seeded data for load test. Opens at:', opensAt);
  await handle.end();
}

run().catch(console.error);
