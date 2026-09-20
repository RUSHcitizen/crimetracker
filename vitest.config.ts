import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{shared,server,web}/test/**/*.test.ts'],
    globals: false,
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      '@crimetracker/shared': new URL('./shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
