import { describe, it, expect } from 'vitest';
import { Config, ReleaseSectionDef, RELEASE_SECTION_PRESETS, DEFAULT_RELEASE_SECTIONS, applySectionPreset, sectionPresetOf } from '../src/index.ts';

describe('release section presets (#376)', () => {
  it('ships plain (the default), changelog, iOS App Store and Google Play, each a valid releases.sections', () => {
    expect(RELEASE_SECTION_PRESETS.map((p) => p.id)).toEqual(['plain', 'changelog', 'app-store', 'google-play']);
    for (const p of RELEASE_SECTION_PRESETS) expect(p.sections.map((s) => ReleaseSectionDef.parse(s))).toEqual(p.sections);
    expect(sectionPresetOf(Config.parse({ schema_version: 2, tool_version: 'x', project: { name: 'p', id_prefix: 'P' }, code_repo: { path: '.', default_branch: 'main' }, models: [{ id: 'm', label: 'M' }], defaults: { planner: 'm', implementer: 'm', category: 'c' }, categories: ['c'] }).releases.sections)).toBe('plain');
    expect(RELEASE_SECTION_PRESETS.find((p) => p.id === 'app-store')!.sections.find((s) => s.title === 'Subtitle')).toMatchObject({ max_chars: 30, carry: true });
    expect(RELEASE_SECTION_PRESETS.find((p) => p.id === 'google-play')!.sections.find((s) => s.title === 'Short description')).toMatchObject({ max_chars: 80, carry: true });
  });

  it('keeps the headings a project already has, in its spelling, and lists the ones the preset drops', () => {
    const current: ReleaseSectionDef[] = [{ title: 'Release notes', carry: false }, { title: 'subtitle', max_chars: 25, carry: true }, { title: 'Checklist', carry: false }];
    const play = RELEASE_SECTION_PRESETS.find((p) => p.id === 'app-store')!.sections;
    const r = applySectionPreset(current, play);
    expect(r.sections.map((s) => s.title)).toEqual(["What's New", 'subtitle', 'Promotional text', 'Keywords', 'Description', 'Notes']);
    expect(r.sections[1]).toMatchObject({ max_chars: 30, carry: true });   // the preset's settings, the project's heading
    expect(r.dropped).toEqual(['Release notes', 'Checklist']);
    expect(applySectionPreset(DEFAULT_RELEASE_SECTIONS, DEFAULT_RELEASE_SECTIONS)).toEqual({ sections: DEFAULT_RELEASE_SECTIONS, dropped: [] });
  });

  it('names the preset in use only while the sections are exactly it', () => {
    const changelog = RELEASE_SECTION_PRESETS.find((p) => p.id === 'changelog')!.sections;
    expect(sectionPresetOf(changelog)).toBe('changelog');
    expect(sectionPresetOf([...changelog.slice(0, -1), { ...changelog.at(-1)!, max_chars: 10 }])).toBeUndefined();
  });
});
