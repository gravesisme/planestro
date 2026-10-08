import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

vi.mock('../src/store.ts', () => ({ useStore: () => undefined, act: () => {} }));
import { childQueueState, ChildQueue } from '../src/components/ChildQueue.tsx';

/**
 * #284: an epic's Children list showed each child's status, but queueing one meant opening it, and nothing said why a
 * child was not ready. A not-yet-submitted child whose dependencies are done can be queued from the list; one that is
 * not says which dependency it still waits on, and what that one is doing.
 */
const fm = (status: string, depends_on: string[] = []) => ({ status, depends_on }) as any;
const items: Record<string, any> = {
  'HH-349': fm('QUEUED'), 'HH-437': fm('FINISHED'), 'HH-347': fm('MERGED'), 'HH-350': fm('NOT_YET_SUBMITTED'),
};
const lookup = (id: string) => items[id];

describe("an epic's children: queue, or what they wait on (#284)", () => {
  it('a not-yet-submitted child whose dependencies are merged or finished can be queued', () => {
    expect(childQueueState(fm('NOT_YET_SUBMITTED'), lookup)).toEqual({ kind: 'queue' });
    expect(childQueueState(fm('NOT_YET_SUBMITTED', ['HH-437', 'HH-347']), lookup)).toEqual({ kind: 'queue' });
  });

  it('one with an open dependency names exactly the open ones, with their status', () => {
    expect(childQueueState(fm('NOT_YET_SUBMITTED', ['HH-349', 'HH-437', 'HH-350']), lookup)).toEqual({ kind: 'waits', on: [{ id: 'HH-349', status: 'QUEUED' }, { id: 'HH-350', status: 'NOT_YET_SUBMITTED' }] });
    expect(childQueueState(fm('NOT_YET_SUBMITTED', ['HH-999']), lookup)).toEqual({ kind: 'waits', on: [{ id: 'HH-999', status: undefined }] });
  });

  it('until the epic has its branch, a child cannot be queued, and says so', () => {
    expect(childQueueState(fm('NOT_YET_SUBMITTED'), lookup, false)).toEqual({ kind: 'epic_closed' });
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ChildQueue, { id: 'HH-350', state: { kind: 'epic_closed' } })));
    expect(html).toContain('waits on the epic branch (Open epic branch above)');
    expect(html).not.toContain('<button');
  });

  it('a child in any other status gets nothing new', () => {
    for (const s of ['QUEUED', 'IN_PROGRESS', 'FINISHED', 'ICEBOX']) expect(childQueueState(fm(s), lookup)).toBeUndefined();
  });

  it('renders a Queue button, or the open dependencies linked to their items', () => {
    const queue = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ChildQueue, { id: 'HH-350', state: { kind: 'queue' } })));
    expect(queue).toMatch(/<button[^>]*>Queue<\/button>/);
    const waits = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ChildQueue, { id: 'HH-351', state: { kind: 'waits', on: [{ id: 'HH-349', status: 'QUEUED' }, { id: 'HH-999', status: undefined }] } })));
    expect(waits).toContain('waits on');
    expect(waits).toMatch(/<a href="\/items\/HH-349"[^>]*>HH-349<\/a> \(queued\)/);
    expect(waits).toContain('HH-999 (not found)');
    expect(waits).not.toContain('<button');
  });
});
