import { describe, it, expect } from 'vitest';
import { resolveClaudeBin, newerVersion, bundledClaudeVersion } from '../src/engine/sessions/claudeBin.ts';
import { noteApiErrorText } from '../src/engine/sessions/LiveClaudePort.ts';
import type { TurnResult } from '../src/engine/ports.ts';
import { quietTransientFailure } from '../src/engine/transient.ts';

const ok = (): TurnResult => ({ subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' });

describe('which Claude Code runs the sessions (p4)', () => {
  it('compares dotted versions numerically', () => {
    expect(newerVersion('2.1.281', '2.1.251')).toBe(true);
    expect(newerVersion('2.1.251', '2.1.251')).toBe(false);
    expect(newerVersion('2.1.99', '2.1.251')).toBe(false);
    expect(newerVersion('3.0', '2.9.999')).toBe(true);
  });

  it('prefers claude_bin, then an installed claude newer than the bundled one, then the bundled one', () => {
    const newer = () => ({ path: '/u/.local/bin/claude', version: '2.1.281' });
    const older = () => ({ path: '/usr/bin/claude', version: '2.1.200' });
    expect(resolveClaudeBin('/opt/claude', '2.1.251', newer).bin).toBe('/opt/claude');
    expect(resolveClaudeBin('bundled', '2.1.251', newer).bin).toBeUndefined();
    const picked = resolveClaudeBin(undefined, '2.1.251', newer);
    expect(picked).toMatchObject({ bin: '/u/.local/bin/claude', version: '2.1.281' });
    expect(picked.why).toContain('newer than the SDK\'s bundled 2.1.251');
    expect(resolveClaudeBin(undefined, '2.1.251', older).bin).toBeUndefined();
    expect(resolveClaudeBin(undefined, '2.1.251', () => undefined).bin).toBeUndefined();
  });

  it('reads the bundled version from the installed SDK', () => {
    expect(bundledClaudeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('an API error returned as text is a failure (p5)', () => {
  it('classifies the CLI-too-old answer and other API errors, and leaves real answers alone', () => {
    const r1 = ok(); noteApiErrorText({ type: 'result', subtype: 'success', is_error: false, result: 'API Error: 400 Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required.' }, r1);
    expect(r1).toMatchObject({ isError: true, subtype: 'cli_too_old' });
    const r2 = ok(); noteApiErrorText({ type: 'result', subtype: 'success', is_error: false, result: 'API Error: 529 {"type":"overloaded_error"}' }, r2);
    expect(r2).toMatchObject({ isError: true, subtype: 'api_error' });
    // The overload the CLI printed in the model's place is not the model saying something: retried by itself (#241); the CLI-too-old one is not.
    expect(quietTransientFailure({ ...r2, text: 'API Error: 529 {"type":"overloaded_error"}\n' })).toBe(true);
    expect(quietTransientFailure({ ...r1, text: 'API Error: 400 Claude Code 2.1.251 does not support this model\n' })).toBe(false);
    const r3 = ok(); noteApiErrorText({ type: 'result', subtype: 'success', is_error: false, result: 'Plan submitted. The API Error: 400 case is handled in step 3.' }, r3);
    expect(r3).toMatchObject({ isError: false, subtype: 'success' });
  });
});
