import type { Job, Processor } from 'bullmq';
import { JwtService } from '@nestjs/jwt';
import { createStandaloneDb } from '../../../src/shared/db/db.module.js';
import { createEnvEmailProvider } from '../../../src/shared/notifications/email-provider.js';
import { MagicTokenService } from '../../../src/modules/notifications/magic-token.service.js';
import { StageRunner } from '../../../src/modules/notifications/stage-runner.js';
import type { WorkerRuntime } from '../../../src/shared/runtime/worker-lifecycle.js';

/**
 * Email queue processor — executes delivery stages with exactly-once
 * guards (see StageRunner). Runs in the dedicated worker process.
 */
export function createEmailProcessor(): WorkerRuntime {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for the email worker');
  const { db, end } = createStandaloneDb(url);

  const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'dev-secret' });
  const magicTokens = new MagicTokenService(jwt);
  const email = createEnvEmailProvider(); // production (Resend) when RESEND_API_KEY set
  const runner = new StageRunner(db, email, magicTokens);

  const processor: Processor = async (job: Job<{ periodId: string; stage: string }>) => {
    const stage = job.data.stage as Parameters<StageRunner['runStage']>[1];
    return runner.runStage(job.data.periodId, stage);
  };

  return { processor, shutdown: () => end() };
}
