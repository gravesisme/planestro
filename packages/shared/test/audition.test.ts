import { describe, it, expect } from 'vitest';
import { Audition, AuditionPicks, auditionProblem, auditionPicksProblem, auditionPickLines, auditionNote, auditionComplete, auditionTakes } from '../src/audition.ts';

const takes = (role: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => `tmp/${role}_${from + i}.wav`);

describe('auditions in rounds: several picks per role, keep some, regenerate the rest (#318)', () => {
  const round1 = Audition.parse({
    title: 'Desert ambience',
    roles: [
      { id: 'wind', name: 'Wind loop', pick: 3, takes: takes('wind', 8) },
      { id: 'sand', name: 'Sand step', pick: 3, takes: takes('sand', 8) },
    ],
  });

  it('accepts 0 to n picks per role with regenerate, and refuses more than n', () => {
    expect(auditionProblem(round1)).toBeUndefined();
    for (let k = 0; k <= 3; k++) {
      const picks = AuditionPicks.parse({ wind: { takes: takes('wind', k), regenerate: '' }, sand: { takes: takes('sand', 3) } });
      expect(auditionPicksProblem(round1, picks)).toBeUndefined();
    }
    expect(auditionPicksProblem(round1, AuditionPicks.parse({ wind: { takes: takes('wind', 4) }, sand: { takes: takes('sand', 3) } }))).toMatch(/at most 3/);
    // Fewer than n without regenerate leaves the role unfilled.
    expect(auditionPicksProblem(round1, AuditionPicks.parse({ wind: { takes: takes('wind', 2) }, sand: { takes: takes('sand', 3) } }))).toMatch(/Wind loop/);
    // Only the role's own takes, each once.
    expect(auditionPicksProblem(round1, AuditionPicks.parse({ wind: { takes: takes('sand', 3) }, sand: { takes: takes('sand', 3) } }))).toMatch(/not one of the takes/);
    expect(auditionPicksProblem(round1, AuditionPicks.parse({ wind: { takes: ['tmp/wind_0.wav', 'tmp/wind_0.wav'], regenerate: '' }, sand: { takes: takes('sand', 3) } }))).toMatch(/twice/);
  });

  it('answers each role with the takes it keeps and how many more to make, with the note', () => {
    const picks = AuditionPicks.parse({ wind: { takes: ['tmp/wind_0.wav', 'tmp/wind_2.wav'], regenerate: '  less\n reverb ' }, sand: { takes: [], regenerate: '' } });
    expect(auditionPickLines(round1, picks)).toEqual([
      'wind keep tmp/wind_0.wav tmp/wind_2.wav; regenerate 1 more: less reverb',
      'sand regenerate 3 more',
    ]);
    expect(auditionComplete(round1, picks)).toBe(false);
    const note = auditionNote(round1, picks);
    expect(note).toContain('**Audition: Desert ambience**');
    expect(note).toContain('- Wind loop (`wind`): `tmp/wind_0.wav`, `tmp/wind_2.wav` (2 of 3); regenerate 1 more: less reverb');
    expect(note).toContain('- Sand step (`sand`): none kept (0 of 3); regenerate 3 more');
  });

  it('a second round shows round one\'s keeps as kept and completes when every role reaches n', () => {
    const round2 = Audition.parse({
      title: 'Desert ambience',
      roles: [
        { id: 'wind', name: 'Wind loop', pick: 3, kept: ['tmp/wind_0.wav', 'tmp/wind_2.wav'], takes: takes('wind', 3, 10) },
        { id: 'sand', name: 'Sand step', pick: 3, kept: takes('sand', 3) },
      ],
    });
    expect(auditionProblem(round2)).toBeUndefined();
    expect(auditionTakes(round2)).toContain('tmp/wind_0.wav');
    // The kept takes are not picked again, and the full role takes no picks.
    expect(auditionPicksProblem(round2, AuditionPicks.parse({ wind: { takes: ['tmp/wind_0.wav'] } }))).toMatch(/not one of the takes/);
    expect(auditionPicksProblem(round2, AuditionPicks.parse({ wind: { takes: ['tmp/wind_10.wav', 'tmp/wind_11.wav'] } }))).toMatch(/at most 1/);
    expect(auditionPicksProblem(round2, AuditionPicks.parse({ wind: { takes: ['tmp/wind_11.wav'] }, sand: { takes: ['tmp/sand_5.wav'] } }))).toMatch(/Sand step.*already/);
    const picks = AuditionPicks.parse({ wind: { takes: ['tmp/wind_11.wav'] } });
    expect(auditionPicksProblem(round2, picks)).toBeUndefined();
    expect(auditionComplete(round2, picks)).toBe(true);
    expect(auditionPickLines(round2, picks)).toEqual([
      'wind keep tmp/wind_0.wav tmp/wind_2.wav tmp/wind_11.wav',
      `sand keep ${takes('sand', 3).join(' ')}`,
    ]);
    expect(auditionNote(round2, picks)).toContain('- Wind loop (`wind`): `tmp/wind_0.wav`, `tmp/wind_2.wav`, `tmp/wind_11.wav` (3 of 3)');
  });

  it('refuses an audition that cannot be answered: too many keeps, a take kept and offered, nothing left to pick', () => {
    expect(auditionProblem(Audition.parse({ title: 't', roles: [{ id: 'a', name: 'A', pick: 1, kept: ['x.wav', 'y.wav'], takes: [] }] }))).toMatch(/keeps 2/);
    expect(auditionProblem(Audition.parse({ title: 't', roles: [{ id: 'a', name: 'A', pick: 2, kept: ['x.wav'], takes: ['x.wav', 'y.wav'] }] }))).toMatch(/both kept and offered/);
    expect(auditionProblem(Audition.parse({ title: 't', roles: [{ id: 'a', name: 'A', pick: 2, kept: ['x.wav'], takes: [] }] }))).toMatch(/no takes/);
    expect(auditionProblem(Audition.parse({ title: 't', roles: [{ id: 'a', name: 'A', kept: ['x.wav'] }] }))).toMatch(/nothing left to pick/);
    expect(Audition.safeParse({ title: 't', roles: [{ id: 'a', name: 'A', takes: takes('a', 30) }] }).success).toBe(true);
    expect(Audition.safeParse({ title: 't', roles: [{ id: 'a', name: 'A', takes: takes('a', 31) }] }).success).toBe(false);
  });

  it('an audition parked in the old shape (one pick, allow_regenerate) still reads and takes its answer', () => {
    const old = Audition.parse({ title: 'Old', roles: [{ id: 'wind', name: 'Wind', takes: ['tmp/a.mp3', 'tmp/b.mp3'] }], allow_regenerate: false });
    expect(auditionProblem(old)).toBeUndefined();
    // The answer as the #207 page sent it, and the new one.
    expect(auditionPickLines(old, AuditionPicks.parse({ wind: { take: 'tmp/b.mp3' } }))).toEqual(['wind keep tmp/b.mp3']);
    // Regenerate is always offered now, whatever allow_regenerate said.
    const again = AuditionPicks.parse({ wind: { regenerate: 'brighter' } });
    expect(auditionPicksProblem(old, again)).toBeUndefined();
    expect(auditionPickLines(old, again)).toEqual(['wind regenerate 1 more: brighter']);
  });
});
