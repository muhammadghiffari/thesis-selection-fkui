import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'workers/src/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
