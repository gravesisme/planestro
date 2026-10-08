import { describe, it, expect } from 'vitest';
import { enterSends, growTo, pickable } from '../src/chatInput.ts';

const key = (k: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }>) => ({ key: 'Enter', shiftKey: false, isComposing: false, ...k });

describe('the orchestrator chat input (#288)', () => {
  it('Enter sends on a desktop; Shift+Enter, composing text and any Enter on a phone make a new line', () => {
    expect(enterSends(key({}), false)).toBe(true);
    expect(enterSends(key({ shiftKey: true }), false)).toBe(false);
    expect(enterSends(key({ isComposing: true }), false)).toBe(false);
    expect(enterSends(key({}), true)).toBe(false);
    expect(enterSends(key({ key: 'a' }), false)).toBe(false);
  });

  it('grows with its text up to 40% of the screen, then scrolls inside', () => {
    expect(growTo(40, 800)).toEqual({ height: 40, scroll: false });
    expect(growTo(300, 800)).toEqual({ height: 300, scroll: false });
    expect(growTo(900, 800)).toEqual({ height: 320, scroll: true });
    expect(growTo(200, 300)).toEqual({ height: 120, scroll: true });
  });

  it('takes images (a phone photo too, it is converted) and readable files; leaves the rest out, by name', () => {
    const f = (name: string, type = '') => new File([new Uint8Array(4)], name, { type });
    const { take, skipped } = pickable([f('image.png', 'image/png'), f('IMG_1.HEIC', 'image/heic'), f('notes.md'), f('spec.pdf', 'application/pdf'), f('page.html', 'text/html'), f('run.sh')]);
    expect(take.map((x) => x.name)).toEqual(['image.png', 'IMG_1.HEIC', 'notes.md', 'spec.pdf']);
    expect(skipped).toEqual(['page.html', 'run.sh']);
  });
});
