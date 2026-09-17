---
schema: 1
name: art-repaint
kind: template
title: Repaint from a reference image (for an image-generating implementer)
description: A backlog item body for art that must start from an existing picture — a rig render, a rough, a previous version. Attach the reference to the item; the art model receives it.
---
## What to make

Repaint the attached reference into finished art: {{subject}}

The reference is the source of truth for **{{keep_from_reference}}** (for example: pose, silhouette, proportions, framing, where the hands are). Change only the surface: {{what_to_change}}. Edit from the attached image rather than describing it from scratch.

## Deliverable

- File: `{{target_path}}` · size: {{size}} · PNG, transparent background unless stated otherwise.
- It must sit next to: {{match_these_assets}} — open them first and match line weight, palette and level of detail.

## Done means

- The file exists at that path and size, committed on the worker branch.
- The summary says which parts of the reference were kept exactly and which were reinterpreted: an image model repaints the whole picture, so anything that must stay pixel-exact is called out for the project's own finishing step rather than assumed.
- Provenance: {{provenance_rule}}
