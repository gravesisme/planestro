import { describe, it, expect } from 'vitest';
import { parseChildList, childrenFromList } from '../src/childList.ts';
import { validateBreakdown } from '../src/breakdown.ts';

/**
 * #239: one change applied to many targets (packages, routes, assets) is one child per target. A prompt template and a
 * list render the children into the breakdown panel, where the user reviews them before anything is created.
 */
const spec = { template: 'Bump the lint config in packages/{{item}} and fix what it flags there.', implementer: 'opus-5' };

describe('parseChildList', () => {
  it('reads lines, dropping blanks and list markers', () => {
    const r = parseChildList('- shared\n\n* server\n3. web\n  docs  \n');
    expect(r).toMatchObject({ format: 'lines' });
    if ('problem' in r) throw new Error(r.problem);
    expect(r.entries.map((e) => e.item)).toEqual(['shared', 'server', 'web', 'docs']);
    expect(r.entries.every((e) => e.depends_on.length === 0)).toBe(true);
  });

  it('reads CSV with a header row, quoted fields and depends_on as entry numbers', () => {
    const r = parseChildList('name,path,depends_on\nshared,"packages/shared, the core",\nserver,packages/server,1\n"we""b",packages/web,"1 2"\r\n', 'csv');
    if ('problem' in r) throw new Error(r.problem);
    expect(r.format).toBe('csv');
    expect(r.entries.map((e) => e.item)).toEqual(['shared', 'server', 'we"b']);
    expect(r.entries[0].fields.path).toBe('packages/shared, the core');
    expect(r.entries.map((e) => e.depends_on)).toEqual([[], [0], [0, 1]]);
  });

  it('reads JSON: strings or objects, `item` or the first field naming the entry', () => {
    const r = parseChildList('[{"pkg":"shared","owner":"me"},{"pkg":"web","item":"the web app","depends_on":[1]},"docs"]');
    if ('problem' in r) throw new Error(r.problem);
    expect(r.format).toBe('json');
    expect(r.entries.map((e) => e.item)).toEqual(['shared', 'the web app', 'docs']);
    expect(r.entries[1].depends_on).toEqual([0]);
  });

  it('names what is wrong instead of guessing', () => {
    expect(parseChildList('  \n ')).toEqual({ problem: 'the list has no entries' });
    expect(parseChildList('{"a":1}', 'json')).toMatchObject({ problem: expect.stringMatching(/JSON array/) });
    expect(parseChildList('[1,', 'json')).toMatchObject({ problem: expect.stringMatching(/not valid JSON/) });
    expect(parseChildList('[null]', 'json')).toMatchObject({ problem: expect.stringMatching(/entry 1/) });
    expect(parseChildList('a,b\n1,2,3', 'csv')).toMatchObject({ problem: expect.stringMatching(/row 2 has 3 fields; the header has 2/) });
    expect(parseChildList('a,b\n"open,2', 'csv')).toMatchObject({ problem: expect.stringMatching(/unclosed quote/) });
    expect(parseChildList('name,depends_on\na,\nb,3', 'csv')).toMatchObject({ problem: expect.stringMatching(/entry 2 depends on 3, which is not an entry \(1–2\)/) });
    expect(parseChildList('name,depends_on\na,first', 'csv')).toMatchObject({ problem: expect.stringMatching(/entry 1 depends on "first"/) });
    expect(parseChildList('name,depends_on\na,1', 'csv')).toMatchObject({ problem: expect.stringMatching(/entry 1 depends on itself/) });
  });

  it('auto reads JSON when the text is a JSON array, else lines', () => {
    expect(parseChildList('["a","b"]')).toMatchObject({ format: 'json' });
    expect(parseChildList('a, b\nc')).toMatchObject({ format: 'lines', entries: [{ item: 'a, b' }, { item: 'c' }] });
  });
});

describe('childrenFromList', () => {
  it('renders one independent child per entry, ready for the breakdown panel', () => {
    const { children, problem } = childrenFromList({ ...spec, list: 'shared\nserver\nweb' });
    expect(problem).toBeNull();
    expect(children).toEqual([
      { title: 'shared', description: 'Bump the lint config in packages/shared and fix what it flags there.', implementer: 'opus-5', depends_on: [] },
      { title: 'server', description: 'Bump the lint config in packages/server and fix what it flags there.', implementer: 'opus-5', depends_on: [] },
      { title: 'web', description: 'Bump the lint config in packages/web and fix what it flags there.', implementer: 'opus-5', depends_on: [] },
    ]);
    expect(validateBreakdown(children, [{ id: 'opus-5' }], ['Feature'])).toBeNull();
  });

  it('fills a title template and named fields, keeps depends_on, and carries a category', () => {
    const { children, problem } = childrenFromList({ title: 'Lint {{n}}: {{name}}', template: 'Bump lint in {{path}} ({{name}}), owned by {{owner}}.', list: 'name,path,owner,depends_on\nshared,packages/shared,me,\nweb,packages/web,you,1', format: 'csv', implementer: 'opus-5', category: 'Bug' });
    expect(problem).toBeNull();
    expect(children.map((c) => c.title)).toEqual(['Lint 1: shared', 'Lint 2: web']);
    expect(children[1]).toMatchObject({ description: 'Bump lint in packages/web (web), owned by you.', depends_on: [0], category: 'Bug' });
  });

  it('refuses a template that names a field the list lacks, and briefs that come out the same', () => {
    expect(childrenFromList({ ...spec, template: 'Fix {{pkg}} please, all of it.', list: 'a\nb' }).problem).toMatch(/entry 1 \("a"\) has no pkg: use \{\{item\}\} or \{\{n\}\}/);
    expect(childrenFromList({ ...spec, template: 'Fix the lint everywhere, all of it.', list: 'a\nb' }).problem).toMatch(/entries 1 and 2 get the same brief/);
    expect(childrenFromList({ ...spec, template: '  ', list: 'a' }).problem).toMatch(/prompt template/);
    expect(childrenFromList({ ...spec, list: '' }).problem).toBe('the list has no entries');
  });
});
