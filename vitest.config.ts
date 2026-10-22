import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Every git call in tests ignores the owner's global and system git config.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20000, env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } },
});
