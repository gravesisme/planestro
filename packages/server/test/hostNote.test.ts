import { describe, it, expect } from 'vitest';
import { hostNote } from '../src/engine/hostNote.ts';

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
