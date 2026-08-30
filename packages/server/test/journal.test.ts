import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal } from '../src/store/Journal.ts';

describe('Journal', () => {
  it('appends NDJSON per month, filters, and finds open ops', () => {
    const j = new Journal(join(mkdtempSync(join(tmpdir(), 'pj-')), 'journal'));
    const op1 = j.begin('rebasing', 'X-1', { base: 'abc' });
    const op2 = j.begin('pushing', 'X-2');
    j.end(op1, 'X-1', 'ok');
    j.append({ type: 'item.updated', item: 'X-1', actor: 'user' });
    expect(j.read({ item: 'X-1' }).map((e) => e.type)).toEqual(['op.begin', 'op.end', 'item.updated']);
    const open = j.openOps();
    expect(open).toHaveLength(1);
    expect(open[0].data).toMatchObject({ op: 'pushing', op_id: op2 });
    expect(j.read({ limit: 1 })[0].type).toBe('item.updated');
  });
});
