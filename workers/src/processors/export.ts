import type { Job, Processor } from 'bullmq';
import { createStandaloneDb } from '../../../src/shared/db/db.module.js';
import { createEnvEmailProvider } from '../../../src/shared/notifications/email-provider.js';
import { ReportsService } from '../../../src/modules/reports/reports.service.js';
import type { WorkerRuntime } from '../../../src/shared/runtime/worker-lifecycle.js';

/** export queue processor — builds report files, notifies requester once. */
export function createExportProcessor(): WorkerRuntime {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for the export worker');
  const { db, end } = createStandaloneDb(url);
  // EventBus/realtime pushes are handled inside the service via redis publish
  const service = new ReportsService(
    db,
    createEnvEmailProvider(),
    { emit: () => undefined, on: () => () => undefined } as never,
  );

  const processor: Processor = async (job: Job<{ jobId?: string }>) => {
    if (!job.data.jobId) throw new Error('jobId required');
    return service.processJob(job.data.jobId);
  };

  return { processor, shutdown: () => end() };
}
