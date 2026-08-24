import type { Job, Processor } from 'bullmq';
import { JwtService } from '@nestjs/jwt';
import { createStandaloneDb } from '../../../src/shared/db/db.module.js';
import { StubEmailProvider } from '../../../src/shared/notifications/email-provider.js';
import { MagicTokenService } from '../../../src/modules/notifications/magic-token.service.js';
import { StageRunner } from '../../../src/modules/notifications/stage-runner.js';

/**
 * Email queue processor — executes delivery stages with exactly-once
 * guards (see StageRunner). Runs in the dedicated worker process.
 */
export function createEmailProcessor(): { processor: Processor; stub: StubEmailProvider } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for the email worker');
  const { db } = createStandaloneDb(url);

  const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'dev-secret' });
  const magicTokens = new MagicTokenService(jwt);
  const stub = new StubEmailProvider(); // worker-side transport is stub until F9
  const runner = new StageRunner(db, stub, magicTokens);

  const processor: Processor = async (job: Job<{ periodId: string; stage: string }>) => {
    const stage = job.data.stage as Parameters<StageRunner['runStage']>[1];
    return runner.runStage(job.data.periodId, stage);
  };

  return { processor, stub };
}
