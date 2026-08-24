import type { Job, Processor } from 'bullmq';
import Redis from 'ioredis';
import { createStandaloneDb } from '../../../src/shared/db/db.module.js';
import { HashingEmbeddingProvider, type EmbeddingProvider } from '../../../src/shared/embeddings/embedding-provider.js';
import { WarRunner } from '../../../src/modules/war/war-runner.js';

/** expiry_events processor — auto-war pass at opens_at (heartbeat-gated). */
export function createExpiryEventsProcessor(): Processor {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for the expiry-events worker');
  const { db } = createStandaloneDb(url);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const embeddings: EmbeddingProvider = new HashingEmbeddingProvider();
  const runner = new WarRunner(db, redis, embeddings);

  return async (job: Job<{ periodId?: string }>) => {
    if (!job.data.periodId) throw new Error('periodId required');
    const outcomes = await runner.runAutoWar(job.data.periodId);
    console.log(`auto_war ${job.data.periodId}: ${JSON.stringify(outcomes).length}b processed`);
    return outcomes;
  };
}
