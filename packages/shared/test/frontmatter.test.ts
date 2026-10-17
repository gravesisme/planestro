import { describe, it, expect } from 'vitest';
import { splitFrontmatter } from '../src/frontmatter.ts';

describe('frontmatter from a hand-edited file', () => {
  it('reads through a byte-order mark and CRLF line ends', () => {
    expect(splitFrontmatter('﻿---\r\nid: X-1\r\n---\r\nbody')).toEqual({ data: { id: 'X-1' }, body: 'body' });
  });

  it('a __proto__ key never becomes the prototype', () => {
    const { data } = splitFrontmatter('---\nid: X-1\n__proto__:\n  polluted: 1\n---\n');
    expect((data as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(data).toEqual({ id: 'X-1' });
  });

  it('null means unset, and a list is not a mapping', () => {
    expect(splitFrontmatter('---\nid: X-1\nparent:\n---\n').data).toEqual({ id: 'X-1' });
    expect(() => splitFrontmatter('---\n- a\n---\n')).toThrow(/mapping/);
  });
});
