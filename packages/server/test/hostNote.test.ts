import { describe, it, expect } from 'vitest';
import { hostNote, keptPathsNote } from '../src/engine/hostNote.ts';

describe('the host note in every session (p21)', () => {
  it('on a Mac without GNU coreutils it says timeout is missing, and what exit 127 means', () => {
    const note = hostNote('darwin', () => false);
    expect(note).toContain('Operating system: macOS.');
    expect(note).toContain('`timeout` is not installed here, nor `gtimeout`');
    expect(note).toContain('exit code 127');
  });

  it('names gtimeout when only it exists, and says nothing about timeout where it is installed', () => {
    expect(hostNote('darwin', (c) => c === 'gtimeout')).toContain('(`gtimeout` is)');
    const linux = hostNote('linux', () => true);
    expect(linux).toContain('Operating system: Linux.');
    expect(linux).not.toContain('not installed');
  });
});

describe('keptPathsNote (#72)', () => {
  it('is empty without copy_to_checkout, and tells workers and the orchestrator the copy is planestro\'s', () => {
    expect(keptPathsNote([], '/repo')).toBe('');
    const worker = keptPathsNote(['tmp/'], '/repo');
    expect(worker).toContain('under `tmp/` in its worktree are copied by planestro into the same folder of the main checkout (/repo)');
    expect(worker).toContain('do not copy them into the main checkout yourself');
    expect(keptPathsNote(['tmp'], '/repo', true)).toContain('not a merge blocker');
  });
});
