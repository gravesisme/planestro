import { describe, it, expect } from 'vitest';
import { ConsoleBuffer } from '../src/store/ConsoleBuffer.ts';

describe('ConsoleBuffer', () => {
  it('collects per-item session output and engine lines, splits multi-line text, caps the buffer', () => {
    const b = new ConsoleBuffer();
    b.handle({ type: 'session.started', id: 'HH-1', session_id: '12345678-abcd' });
    b.handle({ type: 'session.output', id: 'HH-1', text: 'first\nsecond' });
    b.handle({ type: 'engine.log', level: 'info', message: 'hook ok', item: 'HH-1' });
    b.handle({ type: 'engine.log', level: 'info', message: 'global line' }); // no item → nowhere
    b.handle({ type: 'session.ended', id: 'HH-1', subtype: 'success' });
    b.handle({ type: 'session.output', id: 'HH-2', text: 'other item' });
    const lines = b.get('HH-1');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/── session 12345678 turn started ──$/);
    expect(lines[1]).toMatch(/first$/);
    expect(lines[2]).toMatch(/second$/);
    expect(lines[3]).toMatch(/\[engine\] hook ok$/);
    expect(b.get('HH-2')).toHaveLength(1);
    expect(b.get('HH-9')).toEqual([]);
    for (let i = 0; i < 900; i++) b.handle({ type: 'session.output', id: 'HH-1', text: `line ${i}` });
    expect(b.get('HH-1').length).toBe(800);
    expect(b.get('HH-1').at(-1)).toMatch(/line 899$/);
  });
});
