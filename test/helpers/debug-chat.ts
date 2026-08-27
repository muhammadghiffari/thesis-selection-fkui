import { sql } from 'drizzle-orm';
import { startTestApp } from './start-test-app.js';

async function run() {
  const app = await startTestApp();
  
  const chunks = await app.db.execute(sql`SELECT count(*) FROM support_chunks`);
  console.log('Chunks in DB:', chunks.rows);
  
  const queryEmbedding = await app.get('EMBEDDING_PROVIDER').embed("How does the lock mechanism work?");
  const vecLit = `[${queryEmbedding.join(',')}]`;
  
  const rows = await app.db.execute(sql`
    SELECT id, category, content
    FROM support_chunks
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLit}::vector
    LIMIT 1
  `);
  console.log('Query result rows:', rows.rows);
  
  await app.close();
}

run().catch(console.error);
