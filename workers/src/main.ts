import { bootWorkersInProcess, type WorkerFactory } from '../../src/shared/runtime/worker-lifecycle.js';
import { createEmailProcessor } from './processors/email.js';
import { createExpiryEventsProcessor } from './processors/expiry-events.js';
import { createExportProcessor } from './processors/export.js';

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error('REDIS_URL is required');
    process.exit(1);
  }
  const factories: WorkerFactory[] = [
    { name: 'email', ...createEmailProcessor() },
    { name: 'expiry_events', ...createExpiryEventsProcessor() },
    { name: 'export', ...createExportProcessor() },
  ];
  const runtime = await bootWorkersInProcess(redisUrl, factories);
  console.log(`workers online (${runtime.workers.length} registered)`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
