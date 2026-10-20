# Releases

A release is the other half of a backlog: what went out, when, and what the world was told.
Each one is a file in the data dir's `releases/`, next to the items it shipped, so release
notes, store copy and the checklist you ran stop living in a text file somewhere else.

```markdown
---
schema: 1
version: 1.5.0
title: Map update
status: released
date: 2026-09-13
tag: v1.5.0
items: [ HH-101, HH-104, HH-112 ]
created_at: 2026-09-08T21:14:03-04:00
updated_at: 2026-09-13T18:02:40-04:00
---

# Release notes

* Added a dedicated map that shows your location, the shop and unopened chests

# Subtitle

5-min runs. Just one more try.

# Notes

- [x] Screenshots at 2868×1320 and 2064×2752
```

The **Releases** tab lists them newest version first; a release's page edits every field and
section in place (sections save when they lose focus, like an item's).

## Fields

| | |
|---|---|
| `version` | The file name too: letters, digits, dots and dashes. Versions sort as numbers, so `1.10.0` follows `1.9.2`. Renaming it on the page renames the file in one commit. |
| `title` | Optional: "Map update", "Marketing site only". |
| `status` | `planned` (being put together), `submitted` (with a store or a reviewer), `released`, `cancelled` (never shipped). |
| `date` | The day it is aimed at while planned, the day it shipped once released. Marking a release `released` records today, unless its date is already in the past (an old release recorded after the fact). |
| `tag` | The git tag it shipped as, for your reference. planestro does not create or read tags. |
| `items` | The backlog items that went out in it. |

## Sections are the project's

What a release needs written down depends on where it ships, so the sections come from
`releases.sections` in `planestro.yml`, in order. Without the key a project gets **Release notes**
and **Notes**; every release page says which sections it has, with a **Customize →** link to
Settings → Data → Release sections.

Settings starts you from a preset, which you then edit like any other list:

| Preset | Sections |
|---|---|
| Plain (the default) | Release notes, Notes |
| Changelog | Added, Changed, Fixed, Removed, Notes ([Keep a Changelog](https://keepachangelog.com)) |
| iOS App Store | What's New (4000), Subtitle (30), Promotional text (170), Keywords (100), Description (4000), Notes |
| Google Play | Release notes (500), Short description (80), Full description (4000), Notes |

Applying one keeps your releases' text: a heading the project already has keeps its spelling
(and so its text), and headings the preset drops are listed before you save. Their text stays in
the files, shown after the configured sections.

The store presets show what the per-section keys are for. The iOS App Store one, as YAML:

```yaml
releases:
  sections:
    - { title: "What's New", max_chars: 4000 }
    - { title: Subtitle, max_chars: 30, carry: true }
    - { title: Promotional text, max_chars: 170, carry: true }
    - { title: Keywords, max_chars: 100, carry: true }
    - { title: Description, max_chars: 4000, carry: true }
    - { title: Notes, hint: "Checklist, what went wrong, what to do next time." }
```

- `max_chars` puts a counter on the section, red past the limit — a store's field limits,
  checked before you paste rather than after it refuses.
- `carry: true` starts a new release with the previous release's text for that section. Store
  copy rarely changes between versions; release notes always do.
- `hint` is one line under the heading.

A heading added to one file by hand is kept and shown after the configured ones.

Every section has a **copy** button, and **Copy all** puts the whole release on the clipboard as
one markdown document.

## Planning items for a release

An item can say which release it is planned for, ahead of time: `release: 2.0.0` in its
frontmatter, set from the **release** picker on the item's page or the card's preview (the
releases that are `planned` or `submitted`, and none). The card shows it as **for 2.0.0**, and the
board's release filter shows one release's items, or those planned for none. This is what lets a
project plan two lines at once (a 1.x patch while 2.0 is in progress) or number releases that are
not tied to dates.

- **A default for new items.** `releases.default` in `planestro.yml` (Settings → Data → Releases):
  a version, or `next` for the earliest `planned` release. It applies only when an item is created,
  and only while that release is open: a shipped or cancelled one is never a default. An epic's
  children take the epic's release instead. Unset (the default), new items target none.
- **The release page lists what is planned for it**, with each item's status, under **Planned for
  this release**. Marking the release `released` offers the planned items that have landed
  (`MERGED` or `FINISHED`) for its `items` list; **add the N landed** does the same at any time.
- **Renaming, cancelling or deleting a release asks** whether to move its planned items to the new
  version, or clear them. Answer no and they keep naming the old version (the picker shows it as
  such). Nothing is changed silently; a move is one commit, and each item's Activity says so.

`release` is planning data only. The engine never reads it: no branches, no tags, no admission
order.

## Placing backlog items

A release's page offers the finished work that belongs to it: items that are `MERGED` or
`FINISHED`, planned for no release, landed between the release below it and this one (open-ended while it is planned),
and are not in any release yet. Items whose dates were estimated at import (`dates_estimated`) are never offered: their day is a guess. **add** places one, **add all** the lot. Both window ends are
inclusive, so an item merged on a release day is offered to both releases until it is placed in
one. A `cancelled` release places nothing. The item's own page links back to its release.

This is arithmetic on dates, not judgment: it offers, you decide. Nothing about a release is
automated — planestro does not tag, publish or submit anything.
