import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Two projects: everything runs in Node as before, and only the web's *.dom.test.tsx files get a DOM (jsdom, #406).
export default defineConfig({
  test: {
    testTimeout: 20000,
    projects: [
      { extends: true, test: { name: 'node', include: ['packages/*/test/**/*.test.ts'], setupFiles: ['packages/server/test/setup.ts'] } },
      { extends: true, plugins: [react()], test: { name: 'dom', include: ['packages/web/test/**/*.dom.test.tsx'], environment: 'jsdom', setupFiles: ['packages/web/test/dom/setup.tsx'] } },
    ],
  },
});
