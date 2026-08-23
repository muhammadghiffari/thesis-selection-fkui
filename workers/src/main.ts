import { bootWorkers } from './index.js';

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error('REDIS_URL is required');
    process.exit(1);
  }
  // ponytail: processor registry intentionally empty until F2/F3 land their jobs.
  const running = await bootWorkers(redisUrl, {});
  console.log(`workers online (${running.workers.length} registered)`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void running.shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
