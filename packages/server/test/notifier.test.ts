import { describe, it, expect } from 'vitest';
import { appleString, desktopNotify } from '../src/notifier.ts';

/** `planestro notify` (#70): the platform's own way, and never a throw. */
describe('desktopNotify', () => {
  it('uses osascript on a Mac with the strings escaped, notify-send on Linux, nothing elsewhere', async () => {
    const calls: [string, string[]][] = [];
    const run = async (f: string, a: string[]) => { calls.push([f, a]); return { code: 0 }; };
    expect(await desktopNotify('HH-1 merged', 'say "hi"\nnow', { platform: 'darwin', run })).toBe('osascript');
    expect(calls[0]).toEqual(['osascript', ['-e', 'display notification "say \\"hi\\" now" with title "HH-1 merged"']]);
    expect(await desktopNotify('t', 'm', { platform: 'linux', run })).toBe('notify-send');
    expect(calls[1]).toEqual(['notify-send', ['--app-name=planestro', 't', 'm']]);
    expect(await desktopNotify('t', 'm', { platform: 'win32', run })).toBe('none');
    expect(calls).toHaveLength(2);
  });

  it('a failed or missing notifier is "none", never an error', async () => {
    expect(await desktopNotify('t', 'm', { platform: 'darwin', run: async () => ({ code: 1 }) })).toBe('none');
    expect(await desktopNotify('t', 'm', { platform: 'linux', run: async () => { throw new Error('ENOENT'); } })).toBe('none');
    expect(appleString('a\\b')).toBe('"a\\\\b"');
  });
});
