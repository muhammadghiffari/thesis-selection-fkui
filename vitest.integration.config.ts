import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 180_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
    fileParallelism: false,
  },
});
