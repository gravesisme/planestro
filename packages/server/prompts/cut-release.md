---
schema: 1
name: cut-release
kind: action
title: Cut a release
description: Promote the default branch to the release branch (deterministic; the orchestrator only decides when).
---
Merge `{{repo.default_branch}}` into `{{repo.release_branch}}` via a pull request once CI on `{{repo.default_branch}}` is green. No history rewrite.
