---
schema: 1
name: art-item
kind: template
title: Art item (for an image-generating implementer)
description: A backlog item body for raster art. Start an item from it, fill the slots, and set the implementer to your art model.
---
## What to make

{{subject}}

## Deliverable

- File(s): `{{target_path}}` — create the folder if it does not exist. One file per asset; do not overwrite anything the request does not name.
- Size: {{size}} · format: PNG with a transparent background unless stated otherwise.
- Style: {{style}}
- It will be seen next to the project's existing art. Look at what is already in the asset folders before you start and match it; any reference images attached to this item are the target look — edit from them rather than describing them from scratch.

## Done means

- The file exists at the path above, at the stated size, committed on the worker branch.
- The summary names each file and the prompt used to generate it, so a revision can start from the same place.
- Provenance: {{provenance_rule}}
