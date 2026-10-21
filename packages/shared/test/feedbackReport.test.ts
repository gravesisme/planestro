import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PLANESTRO_REPO_URL, REPORT_TRUNCATED, REPORT_URL_MAX, noteTitle, reportIssueUrl } from '../src/feedbackReport.ts';

const parts = (url: string) => { const u = new URL(url); return { base: `${u.origin}${u.pathname}`, title: u.searchParams.get('title') ?? '', body: u.searchParams.get('body') ?? '' }; };

describe('Report to planestro: the new-issue link for a note while feedback.issue_repo is unset', () => {
  it('names planestro\'s repo once, as the root package.json does', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    expect(pkg.bugs.url).toBe(`${PLANESTRO_REPO_URL}/issues`);
    expect(pkg.homepage).toBe(`${PLANESTRO_REPO_URL}#readme`);
    expect(pkg.repository.url).toBe(`git+${PLANESTRO_REPO_URL}.git`);
  });

  it('prefills the title and text, encoded, with a footer naming the version', () => {
    const text = 'Wanted a tool to re-run CI & see "flaky" #tests. Then 100% green?\nSecond line: a=b&c=d';
    const url = reportIssueUrl({ text, version: '0.1.0' });
    expect(url.startsWith(`${PLANESTRO_REPO_URL}/issues/new?title=`)).toBe(true);
    expect(url).not.toMatch(/[ "#\n]/);
    const { base, title, body } = parts(url);
    expect(base).toBe(`${PLANESTRO_REPO_URL}/issues/new`);
    expect(title).toBe('Wanted a tool to re-run CI & see "flaky" #tests.');
    expect(body.startsWith(text)).toBe(true);
    expect(body).toMatch(/Reported from a planestro orchestrator note\. Version: 0\.1\.0\.$/);
    expect(parts(reportIssueUrl({ text })).body).not.toContain('Version');
  });

  it('says nothing of the project the note does not say: no item lead in the title, no project or data dir', () => {
    const text = 'The merge queue skipped a green head.';
    expect(noteTitle('HH-12', text)).toBe('HH-12: The merge queue skipped a green head.');
    const url = reportIssueUrl({ text, version: '0.1.0' });
    expect(parts(url).title).toBe(text);
    for (const leak of ['HH-12', 'hurricane', 'data_dir', '/Users/']) expect(decodeURIComponent(url)).not.toContain(leak);
    // what the note says itself goes as written
    expect(parts(reportIssueUrl({ text: 'HH-12 parked twice.' })).title).toBe('HH-12 parked twice.');
  });

  it('keeps the link under the cap, cutting the body at a code point and saying so', () => {
    const text = `Long note. ${'Ünïcödé 😀 & more words; '.repeat(600)}`;
    const url = reportIssueUrl({ text, version: '0.1.0' });
    expect(url.length).toBeLessThanOrEqual(REPORT_URL_MAX);
    expect(url.length).toBeGreaterThan(REPORT_URL_MAX - 40);
    const { body, title } = parts(url);
    expect(title).toBe('Long note.');
    expect(body).toContain(`\n\n${REPORT_TRUNCATED}\n\n---\nReported from a planestro orchestrator note. Version: 0.1.0.`);
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text.startsWith(body.slice(0, body.indexOf(REPORT_TRUNCATED)).trimEnd())).toBe(true);
    // a short note is never cut
    expect(reportIssueUrl({ text: 'short' })).not.toContain(encodeURIComponent(REPORT_TRUNCATED));
    expect(reportIssueUrl({ text, version: '0.1.0' }, 2000).length).toBeLessThanOrEqual(2000);
  });
});
