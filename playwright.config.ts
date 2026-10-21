// The browser suite (`npm run e2e`): the built web app in Chromium against `planestro sample`, a dry-run engine with
// simulated git, GitHub and agents, so it needs no login or network. Run `npm run build` first: the server serves
// packages/web/dist. The sample and planestro's own home folder go to a temp dir, never ~/.planestro.
import { defineConfig, devices } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!existsSync('packages/web/dist/index.html')) throw new Error('npm run build first: the browser suite runs the built web app');
const port = Number(process.env.PLANESTRO_E2E_PORT ?? 4391);
const root = mkdtempSync(join(tmpdir(), 'planestro-e2e-'));

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  // One sample, one engine: the specs share it, so they run in order.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // No retries: the specs share one sample, and a retry would start from the state the failed run left.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx tsx packages/server/src/cli.ts sample ${join(root, 'sample')} --port ${port}`,
    url: `http://127.0.0.1:${port}/api/state`,
    env: { PLANESTRO_HOME: join(root, 'home') },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
