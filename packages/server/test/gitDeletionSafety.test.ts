import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LiveGitPort } from '../src/engine/live-ports.ts';
import { git, makeFixture } from './helpers.ts';

describe('real Git compare-and-delete (local bare remote only)', () => {
  it('preserves moved/recreated local and remote refs; deletes only the supplied tip', async () => {
    const { root, codeRepo } = makeFixture();
    const port = new LiveGitPort();
    const remote = join(root, 'remote.git'); mkdirSync(remote); git(remote, 'init', '--bare', '-q');
    git(codeRepo, 'remote', 'add', 'origin', remote);
    const first = git(codeRepo, 'rev-parse', 'HEAD').trim();
    git(codeRepo, 'branch', 'worker', first);
    git(codeRepo, 'push', '-q', 'origin', 'worker');
    writeFileSync(join(codeRepo, 'new.txt'), 'new work'); git(codeRepo, 'add', '-A'); git(codeRepo, 'commit', '-qm', 'new work');
    const second = git(codeRepo, 'rev-parse', 'HEAD').trim();
    git(codeRepo, 'branch', '-f', 'worker', second); git(codeRepo, 'push', '-q', 'origin', 'worker');
    await expect(port.deleteLocalBranch(codeRepo, 'worker', first)).rejects.toThrow(/verified tip/);
    await expect(port.deleteLocalBranch(codeRepo, 'worker', null)).rejects.toThrow(/appeared/);
    await expect(port.deleteRemoteBranch(codeRepo, 'worker', first)).rejects.toThrow(/moved/);
    await expect(port.deleteRemoteBranch(codeRepo, 'worker', null)).rejects.toThrow(/appeared/);
    expect(git(codeRepo, 'rev-parse', 'worker').trim()).toBe(second);
    expect(git(remote, 'rev-parse', 'worker').trim()).toBe(second);
    await port.deleteLocalBranch(codeRepo, 'worker', second);
    await port.deleteRemoteBranch(codeRepo, 'worker', second);
    expect(await port.localBranchExists(codeRepo, 'worker')).toBe(false);
    expect(await port.remoteBranchSha(codeRepo, 'worker')).toBeNull();
    // Idempotent retry of a successfully removed branch does not touch another ref.
    await port.deleteLocalBranch(codeRepo, 'worker', second);
    await port.deleteRemoteBranch(codeRepo, 'worker', second);
    await expect(port.deleteLocalBranch(codeRepo, 'trunk', second)).rejects.toThrow(/checked out/);
  });
});
