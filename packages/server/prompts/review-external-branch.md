---
schema: 1
name: review-external-branch
kind: template
title: Review an external branch
description: Review work done by an external agent (e.g. Codex) on its own branch before it is merged.
---
Review the implementation on branch `{{external_branch}}` against this plan:

{{item.plan}}

Report correctness issues, missing tests or checks, and anything that violates the project's conventions (CLAUDE.md / AGENTS.md). If the code is sound, say so explicitly; planestro handles the rebase, pull request and merge.
