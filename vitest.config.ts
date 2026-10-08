import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts'], setupFiles: ['packages/server/test/setup.ts'], testTimeout: 20000 } });
