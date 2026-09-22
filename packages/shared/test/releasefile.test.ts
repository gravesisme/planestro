import { describe, it, expect } from 'vitest';
import { parseReleaseFile, serializeReleaseFile, setReleaseSection, getReleaseSection, compareVersions, sortReleases, nextVersions, releaseCandidates, releaseMarkdown, charCount } from '../src/releasefile.ts';
import { Config, DEFAULT_RELEASE_SECTIONS, type ReleaseSectionDef } from '../src/schema.ts';
import { canonicalTimestamp } from '../src/timestamps.ts';

// Timestamps are written in the machine's offset, so the fixture is too (CI runs in UTC).

const TEXT = `---
schema: 1
version: 1.5.0
status: released
date: 2026-09-13
items: [ HH-101, HH-104 ]
created_at: ${canonicalTimestamp('2026-09-10T09:00:00-04:00')}
updated_at: ${canonicalTimestamp('2026-09-13T18:00:00-04:00')}
---

# Release notes

* Added a dedicated map
* Replaced Axe with a Boomerang

# Subtitle

5-min runs. Just one more try.

# Keywords
`;

const DEFS: ReleaseSectionDef[] = [
  { title: 'Release notes', carry: false }, { title: 'Subtitle', max_chars: 30, carry: true },
  { title: 'Promotional text', max_chars: 170, carry: true }, { title: 'Keywords', max_chars: 100, carry: true },
];

describe('release files', () => {
  it('round-trips byte for byte, empty sections keeping their heading', () => {
    const f = parseReleaseFile(TEXT);
    expect(f.frontmatter).toMatchObject({ version: '1.5.0', status: 'released', date: '2026-09-13', items: ['HH-101', 'HH-104'] });
    expect(getReleaseSection(f, 'Subtitle')).toBe('5-min runs. Just one more try.');
    expect(serializeReleaseFile(f)).toBe(TEXT);
  });

  it('takes a hand-written numeric version as text, and rejects one that cannot be a file name', () => {
    expect(parseReleaseFile(TEXT.replace('version: 1.5.0', 'version: 1.5')).frontmatter.version).toBe('1.5');
    expect(() => parseReleaseFile(TEXT.replace('version: 1.5.0', 'version: ../x'))).toThrow(/version/);
    expect(() => parseReleaseFile(TEXT.replace('date: 2026-09-13', 'date: 09-13-2026'))).toThrow(/date/);
  });

  it('adds a missing section where the project orders it, and demotes a stray H1', () => {
    const f = parseReleaseFile(TEXT);
    setReleaseSection(f, 'Promotional text', 'Just one more try.', DEFS);
    setReleaseSection(f, 'Release notes', '# Big one\n* map', DEFS);
    expect(f.sections.map((s) => s.title)).toEqual(['Release notes', 'Subtitle', 'Promotional text', 'Keywords']);
    expect(getReleaseSection(f, 'Release notes')).toBe('## Big one\n* map');
    setReleaseSection(f, 'Checklist', 'x', DEFS);
    expect(f.sections.at(-1)!.title).toBe('Checklist');
  });

  it('orders versions as numbers, newest first, and suggests the next ones', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1);
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
    expect(sortReleases(['1.3.1', '1.10.0', '0.9'].map((version) => ({ frontmatter: { version } }))).map((r) => r.frontmatter.version)).toEqual(['1.10.0', '1.3.1', '0.9']);
    expect(nextVersions('1.5.0')).toEqual(['1.5.1', '1.6.0', '2.0.0']);
    expect(nextVersions(undefined)).toEqual(['0.1.0', '1.0.0']);
    expect(nextVersions('2026.09')).toEqual([]);
  });

  it('offers the unplaced work that landed in a release window, both ends inclusive', () => {
    const rel = (version: string, status: 'planned' | 'released' | 'cancelled', date: string | undefined, items: string[] = []) => ({ frontmatter: { version, status, date, items } });
    const releases = [rel('1.3.0', 'released', '2026-09-03', ['HH-1']), rel('1.5.0', 'released', '2026-09-13'), rel('1.6.0', 'planned', undefined), rel('1.4.0', 'cancelled', '2026-09-05', ['HH-3'])];
    const done = (id: string, day: string, status = 'FINISHED') => ({ id, fm: { status: status as 'FINISHED', merged_at: `${day}T10:00:00-04:00` } });
    const items = [done('HH-1', '2026-09-01'), done('HH-2', '2026-09-03'), done('HH-3', '2026-09-06'), done('HH-4', '2026-09-13'), done('HH-5', '2026-09-20'), done('HH-6', '2026-09-21', 'IN_REVIEW')];
    expect(releaseCandidates('1.5.0', releases, items).map((i) => i.id)).toEqual(['HH-2', 'HH-3', 'HH-4']); // a cancelled release places nothing
    expect(releaseCandidates('1.6.0', releases, items).map((i) => i.id)).toEqual(['HH-4', 'HH-5']);
    expect(releaseCandidates('1.3.0', releases, items).map((i) => i.id)).toEqual(['HH-2']);
    const imported = { id: 'HH-7', fm: { status: 'FINISHED' as const, merged_at: '2026-09-02T10:00:00-04:00', dates_estimated: true } };
    expect(releaseCandidates('1.3.0', releases, [...items, imported]).map((i) => i.id)).toEqual(['HH-2']); // an imported item's day is a guess
  });

  it('counts characters as a store does, and renders the whole release for pasting', () => {
    expect(charCount(' Déjà vu — 🌀 ')).toBe(11);
    const md = releaseMarkdown(parseReleaseFile(TEXT));
    expect(md).toBe('# 1.5.0 (2026-09-13)\n\n## Release notes\n\n* Added a dedicated map\n* Replaced Axe with a Boomerang\n\n## Subtitle\n\n5-min runs. Just one more try.\n');
  });

  it('a project without a releases block gets the default sections', () => {
    const cfg = Config.parse({ schema_version: 2, tool_version: 'x', project: { name: 'p', id_prefix: 'P' }, code_repo: { path: '.', default_branch: 'main' }, models: [{ id: 'm', label: 'M' }], defaults: { planner: 'm', implementer: 'm', category: 'c' }, categories: ['c'] });
    expect(cfg.releases.sections).toEqual(DEFAULT_RELEASE_SECTIONS);
  });
});
