// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    // CLI entrypoints + async event handlers legitimately print
    files: ['src/scripts/**', 'src/**/*-cli.ts', 'workers/src/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // event-bus handlers must not crash the process; logging the failure is right
    files: ['src/modules/notifications/notifications.service.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*test*.ts'],
    rules: { 'no-console': 'off' },
  },
);
