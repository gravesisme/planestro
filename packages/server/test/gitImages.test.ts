import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveGitPort } from '../src/engine/live-ports.ts';
import { placeholderPng, pngSize } from '../src/engine/placeholderPng.ts';
import { git } from './helpers.ts';

describe('what a branch changed, read from real git', () => {
  it('lists added, modified and deleted files against the merge base and reads both sides of a blob', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'planestro-img-'));
    git(repo, 'init', '-q', '-b', 'trunk');
    mkdirSync(join(repo, 'assets'));
    writeFileSync(join(repo, 'assets/keep.png'), placeholderPng('keep'));
    writeFileSync(join(repo, 'assets/old.png'), placeholderPng('old'));
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'art');
    writeFileSync(join(repo, 'assets/keep.png'), placeholderPng('keep-v2', 48));
    writeFileSync(join(repo, 'assets/new icon.png'), placeholderPng('new'));
    rmSync(join(repo, 'assets/old.png'));
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'art');
    git(repo, 'checkout', '-q', 'trunk'); writeFileSync(join(repo, 'README.md'), 'moved on\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'trunk moves');

    const port = new LiveGitPort();
    const files = await port.changedFiles(repo, 'trunk', 'art');
    expect(files.map((f) => `${f.change} ${f.path}`).sort()).toEqual(['added assets/new icon.png', 'deleted assets/old.png', 'modified assets/keep.png']);
    expect(files.find((f) => f.path === 'assets/keep.png')!.bytes).toBe(placeholderPng('keep-v2', 48).length);
    expect(files.find((f) => f.change === 'deleted')!.bytes).toBeUndefined();
    const mb = (await port.mergeBase(repo, 'trunk', 'art'))!;
    expect(pngSize(await port.readBlob(repo, mb, 'assets/keep.png'))).toEqual({ width: 96, height: 96 });
    expect(pngSize(await port.readBlob(repo, 'art', 'assets/keep.png'))).toEqual({ width: 48, height: 48 });
    expect(await port.readBlob(repo, 'art', 'assets/old.png')).toBeNull();
    expect(pngSize(Buffer.from('not a png at all, just text'))).toBeUndefined();
  });
});
