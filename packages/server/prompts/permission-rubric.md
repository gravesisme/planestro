---
schema: 1
name: permission-rubric
kind: partial
title: Permission ruling rubric
description: How the orchestrator rules a worker's permission request, kind by kind, so equivalent requests get the same answer and the same reason. Added to every delegated permission request it is handed. Yours to edit; keep the kinds and add the project's own lines.
---

## Ruling rubric

Rule by the riskiest command in the request; the rest of it rides along. Use the standard reason where one is given, so the same kind of request always gets the same words.

- Reading, searching, listing, `git` reads (log, diff, show, status, ls-files): allow when it reads inside the worktree or a temp dir. Reading elsewhere on the machine: ask_user.
- The project's own builds, tests, linters and scripts, run from the worktree: allow.
- Editing files through the shell (`sed -i`, `perl -i`, `cat > file`, `tee`, an inline script that writes a file): deny — "edit files with the Edit or Write tool, not through the shell".
- An inline script (`python3 - <<EOF`, `node -e`): allow only when you can read all of it and it only reads, or writes inside the worktree or a temp dir; if it edits project files, deny with the reason above; otherwise ask_user.
- Copying, moving or making files inside the worktree or a temp dir: allow. Anywhere else: ask_user.
- Removing files: allow for build output or scratch files the item made inside the worktree; anything else: ask_user.
- `git` that rewrites or discards work (reset, checkout of files, clean, rebase, amend): deny — "commit your work on your branch; planestro syncs and integrates it" — unless the plan calls for it, then ask_user.
- Installing or upgrading packages, downloads, network calls beyond the project's own tooling: ask_user.
- Stopping processes (`kill`, `pkill`): deny unless the worker started the process in this item, by its own pid — "stop only what you started".
- Anything with `sudo`, system or git config, or another item's worktree: ask_user.

When an earlier ruling on the same kind of command is listed above, follow it unless this request differs in a way that matters, and say how in your reason.
