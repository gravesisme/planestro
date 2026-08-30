import { describe, it, expect } from 'vitest';
import { renderPrompt, RenderError, placeholdersIn } from '../src/placeholders.ts';

describe('placeholders', () => {
  const ctx = { item: { id: 'HH-1', title: 'T', plan: 'do it' }, worktree: '/wt', pr: { number: 7 } };
  const partials = (n: string) => ({ header: 'Item {{item.id}}: {{item.title}}', loop: '{{> loop}}' } as Record<string, string>)[n];
  it('renders dotted paths and partials', () => {
    expect(renderPrompt('{{> header}} in {{worktree}} PR #{{pr.number}}', ctx, partials)).toBe('Item HH-1: T in /wt PR #7');
  });
  it('fails loudly on unresolved placeholders, listing them', () => {
    try { renderPrompt('{{item.nope}} {{> missing}}', ctx, partials, 'tpl'); throw new Error('no throw'); }
    catch (e) { expect(e).toBeInstanceOf(RenderError); expect((e as RenderError).missing).toEqual(['item.nope', '> missing']); expect(String(e)).toContain('tpl'); }
  });
  it('guards partial recursion', () => {
    expect(() => renderPrompt('{{> loop}}', ctx, partials)).toThrow(/depth/);
  });
  it('lists placeholders', () => {
    expect(placeholdersIn('{{a.b}} {{> p}} {{a.b}}')).toEqual(['a.b', '> p']);
  });
});
