import { describe, it, expect } from 'vitest';
import { projectHref } from '../src/projectLink.ts';
import type { ProjectRow } from '../src/api.ts';

/** #235: the all-projects page links to each project on an address the viewer can reach. */
describe('a project link on the all-projects page (#235)', () => {
  const row = (o: Partial<ProjectRow>): ProjectRow => ({ name: 'Lake Monomonac', data_dir: '/w/lm', self: false, reach: 'ok', ...o });
  const local = { protocol: 'http:', hostname: '127.0.0.1' };
  const phone = { protocol: 'http:', hostname: 'mac.tail.ts.net' };
  it('this project opens in place', () => expect(projectHref(row({ self: true }), phone)).toBe('/'));
  it('another opens at its recorded address on this machine', () => expect(projectHref(row({ url: 'http://127.0.0.1:4301', host: '0.0.0.0', port: 4301 }), local)).toBe('http://127.0.0.1:4301/'));
  it('reached from elsewhere, one listening everywhere opens on the name this page was reached by', () => expect(projectHref(row({ url: 'http://127.0.0.1:4301', host: '0.0.0.0', port: 4301 }), phone)).toBe('http://mac.tail.ts.net:4301/'));
  it('one listening on loopback only keeps its own address, and one with no server has no link', () => {
    expect(projectHref(row({ url: 'http://127.0.0.1:4302', host: '127.0.0.1', port: 4302 }), phone)).toBe('http://127.0.0.1:4302/');
    expect(projectHref(row({ reach: 'not_running' }), local)).toBeUndefined();
  });
});
