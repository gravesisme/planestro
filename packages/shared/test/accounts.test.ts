import { describe, it, expect } from 'vitest';
import { LocalConfig, ModelDef, accountList, resolveAccount, guardKey, unavailableKey, unavailableView, sameSessionStore, DEFAULT_ACCOUNT } from '../src/index.ts';

const local = LocalConfig.parse({
  accounts: {
    work: { runner: 'claude', home: '~/.claude-work', label: 'Work Max' },
    max2: { runner: 'claude', home: '~/.claude-max2' },
    spare: { runner: 'codex', home: '/tmp/codex-spare' },
  },
});
const fable = ModelDef.parse({ id: 'fable-5', label: 'Fable 5', claude_model: 'claude-fable-5' });

describe('accounts (#242)', () => {
  it('names a second login per runner by its config folder, never a key', () => {
    expect(() => LocalConfig.parse({ accounts: { x: { runner: 'claude' } } })).toThrow(/home/);
    expect(() => LocalConfig.parse({ accounts: { x: { runner: 'codex' } } })).toThrow(/home/);
    expect(() => LocalConfig.parse({ accounts: { default: { runner: 'claude', home: '/x' } } })).toThrow();
    expect(ModelDef.parse({ ...fable, account: 'work' }).account).toBe('work');
  });

  it('lists the default login first, then the named accounts on that runner', () => {
    expect(accountList(local, 'claude').map((a) => [a.name, a.label])).toEqual([[DEFAULT_ACCOUNT, 'default'], ['work', 'Work Max'], ['max2', 'max2']]);
    expect(accountList(local, 'codex').map((a) => a.name)).toEqual([DEFAULT_ACCOUNT, 'spare']);
  });

  it("a turn runs on the item's account for its runner, else the model row's, else the default", () => {
    expect(resolveAccount(local, 'claude', {})).toMatchObject({ account: { name: 'default' } });
    expect(resolveAccount(local, 'claude', { model: 'work' })).toMatchObject({ account: { name: 'work', home: '~/.claude-work' } });
    expect(resolveAccount(local, 'claude', { item: 'max2', model: 'work' })).toMatchObject({ account: { name: 'max2', home: '~/.claude-max2' } });
    expect(resolveAccount(local, 'claude', { item: 'default', model: 'work' })).toMatchObject({ account: { name: 'default' } });
    // An item moved onto a Claude account still implements on Codex's own login.
    expect(resolveAccount(local, 'codex', { item: 'work' })).toMatchObject({ account: { name: 'default' } });
    expect(resolveAccount(local, 'claude', { model: 'gone' })).toEqual({ missing: 'gone', why: expect.stringMatching(/planestro\.local\.yml/) });
    expect(resolveAccount(local, 'claude', { model: 'spare' })).toMatchObject({ missing: 'spare', why: expect.stringMatching(/codex/) });
  });

  it('keeps guards and outages per account, with the default keyed as before', () => {
    expect(guardKey('claude')).toBe('claude');
    expect(guardKey('claude', 'default')).toBe('claude');
    expect(guardKey('claude', 'work')).toBe('claude:work');
    expect(unavailableKey('fable-5', 'default')).toBe('fable-5');
    expect(unavailableKey('fable-5', 'work')).toBe('fable-5@work');
    const map = { 'fable-5': { until: 'a', reason: 'r' }, 'opus-5@work': { until: 'b', reason: 'r' } };
    expect(Object.keys(unavailableView(map, 'default')!)).toEqual(['fable-5']);
    expect(Object.keys(unavailableView(map, 'work')!)).toEqual(['opus-5']);
    expect(Object.keys(unavailableView(map, 'api')!)).toEqual([]);
  });

  it('resumes across accounts only where the conversation is stored in the same place', () => {
    expect(sameSessionStore(local, undefined, 'default')).toBe(true);
    expect(sameSessionStore(local, 'default', 'work')).toBe(false);     // another CLAUDE_CONFIG_DIR has its own transcripts
    expect(sameSessionStore(local, 'work', 'work')).toBe(true);
    expect(sameSessionStore(local, 'default', 'spare')).toBe(false);
    expect(sameSessionStore(local, 'gone', 'gone')).toBe(false);        // unknown here: never assumed
  });
});
