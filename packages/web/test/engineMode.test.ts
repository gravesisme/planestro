import { describe, it, expect } from 'vitest';
import { modeNote, newItemModeNote } from '../src/engineMode.ts';

describe('the saved vs running engine mode note (#335)', () => {
  it('says nothing while the running engine is the saved one', () => {
    expect(modeNote({ configured: 'live', local: null, saved: 'live', running: 'live', restart_to_apply: false })).toBeUndefined();
    expect(modeNote(undefined)).toBeUndefined();
    expect(newItemModeNote({ configured: 'live', local: null, saved: 'live', running: 'live', restart_to_apply: false })).toBeUndefined();
  });
  it('says a saved live is still simulating until a restart', () => {
    const m = { configured: 'live', local: null, saved: 'live', running: 'dry-run', restart_to_apply: true };
    expect(modeNote(m)).toBe('saved: live · running: dry-run — restart to apply');
    expect(newItemModeNote(m)).toMatch(/simulated/);
  });
  it('names the local override when it is what differs', () => {
    expect(modeNote({ configured: 'dry-run', local: 'live', saved: 'live', running: 'dry-run', restart_to_apply: true })).toBe("saved: live (this machine's planestro.local.yml sets live; the project says dry-run) · running: dry-run — restart to apply");
  });
});
