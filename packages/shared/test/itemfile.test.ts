import { describe, it, expect } from 'vitest';
import { parseItemFile, serializeItemFile, getSection, setSection, appendActivity, parseActivity, slugify, idNumber } from '../src/itemfile.ts';
import { ITEM_KEY_ORDER, AUTHORITATIVE_KEYS, OPERATIONAL_KEYS, DERIVED_KEYS, ItemFrontmatter } from '../src/schema.ts';

const SAMPLE = `---
id: HH-143
title: Desktop UX Improvements
category: Game
status: PLAN_IN_PROGRESS
schema: 1
rank: 1000
planner: fable-5
implementer: opus-5
created_at: 2026-08-30T10:31:00-04:00
updated_at: 2026-08-30T11:04:00-04:00
started_at: 2026-08-30T11:04:00-04:00
branch: hh/143-desktop-ux
worktree: .claude/worktrees/hh-143-desktop-ux
pr: null
depends_on: []
custom_field: keep me
---

# Description

The following changes are intended for the desktop
version of the game...

# Notes

# Plan

# Activity

- 2026-08-30T10:31:00-04:00 [user] created

# Research

Some hand-added section.
`;

describe('item file codec', () => {
  it('parses frontmatter, sections and preserves unknown keys/sections', () => {
    const f = parseItemFile(SAMPLE);
    expect(f.frontmatter.id).toBe('HH-143');
    expect(f.frontmatter.status).toBe('PLAN_IN_PROGRESS');
    expect(f.frontmatter.kind).toBe('item');
    expect((f.frontmatter as any).custom_field).toBe('keep me');
    expect(f.frontmatter.pr).toBeUndefined();
    expect(getSection(f, 'Description')).toContain('desktop\nversion');
    expect(f.sections.map((s) => s.title)).toEqual(['Description', 'Notes', 'Plan', 'Activity', 'Research']);
  });

  it('serializes canonically: key order, omitted nulls, single trailing newline, idempotent', () => {
    const once = serializeItemFile(parseItemFile(SAMPLE));
    const twice = serializeItemFile(parseItemFile(once));
    expect(twice).toBe(once);
    const keys = once.split('---')[1].trim().split('\n').map((l) => l.split(':')[0]);
    const known = keys.filter((k) => ITEM_KEY_ORDER.includes(k));
    expect(known).toEqual([...known].sort((a, b) => ITEM_KEY_ORDER.indexOf(a) - ITEM_KEY_ORDER.indexOf(b)));
    expect(keys[keys.length - 1]).toBe('custom_field');
    expect(once).not.toContain('pr:');
    expect(once).toContain('depends_on: []');
    expect(once.endsWith('\n')).toBe(true);
    expect(once.endsWith('\n\n')).toBe(false);
  });

  it('inserts missing canonical sections in order and keeps unknown ones in place', () => {
    const f = parseItemFile(`---\nschema: 1\nid: X-1\ntitle: t\ncategory: c\nstatus: NOT_YET_SUBMITTED\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n# Plan\n\nstep\n\n# Extra\n\nx\n`);
    expect(f.sections.map((s) => s.title)).toEqual(['Description', 'Notes', 'Plan', 'Activity', 'Extra']);
    expect(getSection(f, 'Plan')).toBe('step');
  });

  it('canonicalizes timestamps to local offset form', () => {
    const f = parseItemFile(SAMPLE.replace('created_at: 2026-08-30T10:31:00-04:00', 'created_at: 2026-08-30T14:31:00Z'));
    expect(f.frontmatter.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(new Date(f.frontmatter.created_at).toISOString()).toBe('2026-08-30T14:31:00.000Z');
  });

  it('appends activity as single lines and parses them back', () => {
    const f = parseItemFile(SAMPLE);
    appendActivity(f, 'app', 'status QUEUED → PLAN_IN_PROGRESS\n  (with newline)', '2026-08-30T12:00:00-04:00');
    const entries = parseActivity(f);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ at: '2026-08-30T12:00:00-04:00', actor: 'app', text: 'status QUEUED → PLAN_IN_PROGRESS (with newline)' });
  });

  it('rejects invalid frontmatter with a readable error', () => {
    expect(() => parseItemFile(SAMPLE.replace('status: PLAN_IN_PROGRESS', 'status: BLOCKED'))).toThrow(/status/);
  });

  it('setSection replaces wholesale', () => {
    const f = parseItemFile(SAMPLE);
    setSection(f, 'Plan', '1. do\n2. things\n');
    expect(getSection(f, 'Plan')).toBe('1. do\n2. things');
  });

  it('helpers', () => {
    expect(slugify('Desktop UX: Improvements!! (v2)')).toBe('desktop-ux-improvements-v2');
    expect(idNumber('HH-143')).toBe(143);
  });
});

describe('schema field classification', () => {
  it('every persisted schema key is classified exactly once and derived keys are never in the schema', () => {
    const schemaKeys = Object.keys(ItemFrontmatter.shape);
    const classified = [...AUTHORITATIVE_KEYS, ...OPERATIONAL_KEYS];
    expect(new Set(classified).size).toBe(classified.length);
    for (const k of schemaKeys) expect(classified, `${k} unclassified`).toContain(k);
    for (const k of classified) expect(schemaKeys, `${k} classified but not in schema`).toContain(k);
    for (const k of DERIVED_KEYS) expect(schemaKeys).not.toContain(k);
  });
});
