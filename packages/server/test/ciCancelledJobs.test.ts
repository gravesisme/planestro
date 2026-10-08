import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(() => {}, { [promisify.custom]: mocked.run });
  return { ...actual, execFile };
});
import { LiveGhPort } from '../src/engine/live-ports.ts';
beforeEach(() => { mocked.run.mockReset(); });

const sha = 'a'.repeat(40);
const url = 'https://github.com/acme/repo/actions/runs/37375447044';
/** HH-344: GitHub rolled the selector's cancelled job up into a run conclusion of `failure`; nothing ran. */
const jobs = [
  { name: 'Select the checks to run', conclusion: 'cancelled', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run selector', conclusion: 'cancelled' }] },
  { name: 'Unit tests', conclusion: 'skipped', steps: [] },
  { name: 'E2E', conclusion: 'skipped', steps: [] },
];
/** `gh` answering run list / run view (jobs or failed log) for one run with the given jobs and failed log. */
function github(runJobs: any[], failedLog = '') {
  mocked.run.mockImplementation(async (_bin: string, args: string[]) => {
    if (args[0] === 'run' && args[1] === 'list') return { stdout: JSON.stringify([{ databaseId: 37375447044, status: 'completed', conclusion: 'failure', headSha: sha, url, createdAt: '2026-10-05T18:00:00Z', attempt: 1 }]), stderr: '' };
    if (args[0] === 'run' && args[1] === 'view' && args.includes('--log-failed')) return { stdout: failedLog, stderr: '' };
    if (args[0] === 'run' && args[1] === 'view') return { stdout: JSON.stringify({ status: 'completed', conclusion: 'failure', url, jobs: runJobs }), stderr: '' };
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });
}

describe('a run whose jobs were only cancelled or skipped (#213, HH-344)', () => {
  it('is read as cancelled, not red, so it is re-run once and then blocks ci_cancelled instead of starting a fix turn', async () => {
    github(jobs);
    expect(await new LiveGhPort().ciForSha('acme/repo', 'worker', sha, 'ci.yml')).toMatchObject({ state: 'cancelled', runId: 37375447044, url });
  });
  it('is still red when a job failed or timed out, even beside cancelled ones', async () => {
    github([...jobs, { name: 'Lint', conclusion: 'failure', steps: [] }]);
    expect((await new LiveGhPort().ciForSha('acme/repo', 'worker', sha, 'ci.yml')).state).toBe('failure');
    github([{ name: 'Build', conclusion: 'timed_out', steps: [] }, ...jobs]);
    expect((await new LiveGhPort().ciForSha('acme/repo', 'worker', sha, 'ci.yml')).state).toBe('failure');
  });
  it('its excerpt names the job and step that did not succeed and the run, and says in words that the log is empty, never a bare "…"', async () => {
    github(jobs);
    const excerpt = await new LiveGhPort().runFailedLog('acme/repo', 37375447044, 120);
    expect(excerpt).toContain('Select the checks to run › Run selector: cancelled');
    expect(excerpt).toContain(url);
    expect(excerpt).toContain('GitHub returned no failed-job log: 1 job cancelled, 2 skipped');
    expect(excerpt.trim()).not.toBe('…');
    expect(excerpt.split('\n')).not.toContain('…');
  });
  it('a red run\'s excerpt leads with its failed job and step, then the log', async () => {
    github([{ name: 'Unit tests', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }] }], 'Unit tests\tnpm test\t2026-10-05T18:01:00Z FAIL src/a.test.ts\n');
    const excerpt = await new LiveGhPort().runFailedLog('acme/repo', 37375447044, 120);
    expect(excerpt.split('\n')[0]).toMatch(/Unit tests › npm test: failure/);
    expect(excerpt).toContain('FAIL src/a.test.ts');
  });
});
