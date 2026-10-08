import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDataDir } from '../src/init.ts';
import { DataStore } from '../src/store/DataStore.ts';
import { writeLocalConfig } from '../src/config.ts';
import { LocalConfig } from '@planestro/shared';
import { makeFixture, git } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });
const dummy = 'review-fixture-not-a-real-credential';

describe('machine-local planning files never enter automatic Git operations', () => {
  it('repairs existing ignores without losing custom rules, including earlier negations', () => {
    const { dataDir, codeRepo } = makeFixture();
    writeFileSync(join(dataDir, '.gitignore'), 'custom-output/\n!planestro.local.yml\n');
    writeFileSync(join(dataDir, 'planestro.local.yml'), `mcp_servers:\n  x:\n    command: c\n    env:\n      TOKEN: ${dummy}\n`);
    initDataDir({ dataDir, codeRepo, register: false });
    expect(readFileSync(join(dataDir, '.gitignore'), 'utf8')).toContain('custom-output/');
    expect(git(dataDir, 'check-ignore', 'planestro.local.yml').trim()).toBe('planestro.local.yml');
    expect(git(dataDir, 'ls-files', 'planestro.local.yml')).toBe('');
    const before = git(dataDir, 'rev-parse', 'HEAD');
    initDataDir({ dataDir, codeRepo, register: false });
    expect(git(dataDir, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('refuses init and startup if local settings are staged or committed, without deleting files', async () => {
    const { dataDir, codeRepo } = makeFixture();
    writeFileSync(join(dataDir, 'planestro.local.yml'), `mcp_servers:\n  x:\n    command: c\n    env:\n      TOKEN: ${dummy}\n`);
    git(dataDir, 'add', '-f', 'planestro.local.yml');
    expect(() => initDataDir({ dataDir, codeRepo, register: false })).toThrow(/machine-local.*tracked/);
    await expect(DataStore.open(dataDir)).rejects.toThrow(/machine-local.*tracked/);
    git(dataDir, 'commit', '-qm', 'intentional fixture');
    git(dataDir, 'rm', '--cached', 'planestro.local.yml');
    await expect(DataStore.open(dataDir)).rejects.toThrow(/machine-local.*tracked/);
    expect(readFileSync(join(dataDir, 'planestro.local.yml'), 'utf8')).toContain(dummy);
  });

  it('excludes private files from checkpoints even if the ignore file is removed, and refuses forced staging', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    writeFileSync(join(dataDir, '.gitignore'), '# no ignores\n');
    store.updateLocal({ mcp_servers: { x: { command: 'c', args: [], env: { TOKEN: dummy }, headers: {} } } });
    mkdirSync(join(dataDir, 'logs')); writeFileSync(join(dataDir, 'logs', 'private.txt'), dummy);
    expect(store.git.checkpoint()).toBe(true);
    expect(git(dataDir, 'ls-files', 'planestro.local.yml', 'logs', '.planestro')).toBe('');
    const before = git(dataDir, 'rev-parse', 'HEAD');
    git(dataDir, 'add', '-f', 'planestro.local.yml');
    expect(store.git.checkpoint()).toBe(false);
    expect(git(dataDir, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('checkpoints staged deletions and treats unusual filenames as literal paths', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    writeFileSync(join(dataDir, '[notes].md'), 'literal filename');
    expect(store.git.checkpoint()).toBe(true);
    expect(git(dataDir, 'show', 'HEAD:[notes].md')).toContain('literal filename');
    git(dataDir, 'rm', '--', '[notes].md');
    expect(store.git.checkpoint()).toBe(true);
    expect(git(dataDir, 'status', '--porcelain')).toBe('');
  });

  it('refuses to push outgoing history containing a private file even after its removal', async () => {
    const { root, dataDir } = makeFixture();
    const remote = join(root, 'remote.git'); mkdirSync(remote); git(remote, 'init', '--bare', '-q');
    git(dataDir, 'remote', 'add', 'origin', remote); git(dataDir, 'push', '-u', 'origin', 'HEAD');
    const before = git(remote, 'rev-parse', 'refs/heads/planning');
    writeFileSync(join(dataDir, 'planestro.local.yml'), `mcp_servers:\n  x:\n    command: c\n    env:\n      TOKEN: ${dummy}\n`);
    git(dataDir, 'add', '-f', 'planestro.local.yml'); git(dataDir, 'commit', '-qm', 'fixture secret');
    git(dataDir, 'rm', '--cached', 'planestro.local.yml'); git(dataDir, 'commit', '-qm', 'fixture removal');
    store = await DataStore.open(dataDir);
    expect(await store.git.push()).toBe(false);
    expect(git(remote, 'rev-parse', 'refs/heads/planning')).toBe(before);
    expect(existsSync(join(dataDir, 'planestro.local.yml'))).toBe(true);
  });

  it('writes local credentials with owner-only permissions, including replacement of an existing file', () => {
    const { dataDir } = makeFixture();
    const path = join(dataDir, 'planestro.local.yml');
    writeFileSync(path, '{}', { mode: 0o644 });
    writeLocalConfig(dataDir, LocalConfig.parse({ mcp_servers: { x: { command: 'c', env: { TOKEN: dummy } } } }));
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain(dummy);
  });
});
