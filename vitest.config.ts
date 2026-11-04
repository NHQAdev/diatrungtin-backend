import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    // Integration tests share one database: run files one after another.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
