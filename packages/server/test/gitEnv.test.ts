import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const gitConfig = (...args: string[]) => execFileSync('git', ['config', ...args], { encoding: 'utf8' }).trim();

describe('the suites run git on a config of their own (setup.ts)', () => {
  it('never signs commits, whatever the developer\'s ~/.gitconfig says', () => {
    expect(gitConfig('--get', 'commit.gpgsign')).toBe('false');
    expect(gitConfig('--get', 'tag.gpgsign')).toBe('false');
  });

  it('takes its identity from that config, as CI does', () => {
    expect(gitConfig('--show-origin', '--get', 'user.email')).toBe(`file:${process.env.GIT_CONFIG_GLOBAL}\ttest@planestro.invalid`);
  });
});
