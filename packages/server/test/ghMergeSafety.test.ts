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

describe('GitHub merge precondition', () => {
  it('passes the verified SHA and never asks gh to delete the branch', async () => {
    mocked.run.mockResolvedValue({ stdout: '', stderr: '' });
    expect(await new LiveGhPort().mergePr('acme/repo', 7, { headSha: 'a'.repeat(40) })).toBe('merged');
    expect(mocked.run).toHaveBeenCalledWith('gh', ['pr', 'merge', '7', '--repo', 'acme/repo', '--merge', '--match-head-commit', 'a'.repeat(40)], expect.anything());
  });
  it('reports a moved head without retrying the merge, and preserves other failures', async () => {
    const port = new LiveGhPort();
    mocked.run.mockRejectedValue(new Error('merge refused'));
    const view = vi.spyOn(port, 'prView').mockResolvedValue({ number: 7, url: 'u', state: 'OPEN', headRefOid: 'b'.repeat(40), headRefName: 'worker', baseRefName: 'trunk' });
    expect(await port.mergePr('acme/repo', 7, { headSha: 'a'.repeat(40) })).toBe('head_moved');
    expect(mocked.run).toHaveBeenCalledTimes(1);
    view.mockResolvedValue({ number: 7, url: 'u', state: 'OPEN', headRefOid: 'a'.repeat(40), headRefName: 'worker', baseRefName: 'trunk' });
    await expect(port.mergePr('acme/repo', 7, { headSha: 'a'.repeat(40) })).rejects.toThrow(/merge refused/);
  });
});
