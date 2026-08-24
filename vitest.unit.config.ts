import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC emits the decorator metadata esbuild cannot — Nest DI + DTO
  // validation then behave in tests exactly as in production builds.
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        target: 'es2022',
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
      module: { type: 'es6' },
    }),
  ],
  test: {
    include: ['test/unit/**/*.test.ts', 'workers/src/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
