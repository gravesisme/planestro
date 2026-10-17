import { describe, it, expect } from 'vitest';
import { loadsHere } from '../src/imageSource.ts';

describe('markdown pictures load from planestro only', () => {
  it('loads attachments, data and blob pictures, and shows anything else as a link', () => {
    for (const s of ['/attachments/HH-1/x.png', '/api/items/HH-1/audition/a.png', 'data:image/png;base64,AAAA', 'blob:http://localhost/1'])
      expect(loadsHere(s), s).toBe(true);
    for (const s of ['https://x.example/?d=secret', 'http://localhost:9999/x.png', '//x.example/a.png', 'data:text/html,<b>', 'javascript:alert(1)', '', undefined])
      expect(loadsHere(s), String(s)).toBe(false);
  });
});
