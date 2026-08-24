import type { Job, Processor } from 'bullmq';
import Redis from 'ioredis';
import { createStandaloneDb } from '../../../src/shared/db/db.module.js';
import { HashingEmbeddingProvider, type EmbeddingProvider } from '../../../src/shared/embeddings/embedding-provider.js';
import { StubEmailProvider } from '../../../src/shared/notifications/email-provider.js';
import { WarRunner } from '../../../src/modules/war/war-runner.js';
import { SwapRunner } from '../../../src/modules/swap/swap-runner.js';

/** expiry_events processor — auto-war pass at opens_at (heartbeat-gated). */
export function createExpiryEventsProcessor(): Processor {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for the expiry-events worker');
  const { db } = createStandaloneDb(url);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const embeddings: EmbeddingProvider = new HashingEmbeddingProvider();
  const warRunner = new WarRunner(db, redis, embeddings);
  const swapRunner = new SwapRunner(db, redis, new StubEmailProvider());

  return async (
    job: Job<{
      periodId?: string;
      type?: 'auto_war' | 'grace_expiry';
      selectionId?: string;
      requestId?: string;
      transitionTs?: number;
    }>,
  ) => {
    if (job.data.type === 'grace_expiry') {
      if (!job.data.selectionId) throw new Error('selectionId required');
      return swapRunner.releaseAfterGrace({
        selectionId: job.data.selectionId,
        requestId: job.data.requestId ?? '',
        transitionTs: job.data.transitionTs ?? Date.now(),
      });
    }
    if (!job.data.periodId) throw new Error('periodId required');
    return warRunner.runAutoWar(job.data.periodId);
  };
}
