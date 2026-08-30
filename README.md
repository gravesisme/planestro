# planestro

Local-first backlog planning and Claude Code orchestration for a solo developer.

You write backlog items as markdown. planestro turns "Queue" into a plan you
approve, an implementation on its own branch and worktree, a pull request,
a rebase, a CI wait, a merge and a cleanup — with a Claude session doing the
thinking and deterministic code doing everything mechanical. When something
needs a human, the session is parked and you are told; answer whenever, and the
same session resumes with its context intact.

## What it is

- **Files are the truth.** One markdown file per item (`items/HH-143.md`: YAML
  frontmatter + `# Description`, `# Notes`, `# Plan`, `# Activity`), a prompt
  library (`prompts/*.md`), small attachments, and an NDJSON journal, all in a
  git-versioned *data dir* with meaningful commits (`HH-143: approve plan`).
  Readable and editable without the tool.
- **Deterministic orchestration.** Git, worktrees, GitHub, CI polling, state
  transitions, persistence, cleanup and scheduling are code. Claude is used for
  planning, implementing and (later) judgment calls — never for polling.
- **Parked, resumable sessions.** No process ever waits on a human. Plan
  approval, permission prompts and agent questions park the session; the UI
  shows a **NEEDS YOU** badge; resuming restores the conversation.
- **Safe by default.** Dry-run mode logs `Would …` instead of acting, a global
  **AUTOMATION PAUSED** lever stops everything new, and nothing is ever deleted
  without positive evidence the work is merged (see `CLAUDE.md` invariants).
- **Project-neutral.** A project is `{code_repo, data_dir}`; the data dir can
  live anywhere — for example an orphan branch of the code repo checked out as
  a nested worktree, so planning history never touches the code's branches.

## Quick start

```sh
npm install
# create a data dir next to (or inside) your repo
npx tsx packages/server/src/cli.ts init ../myproject-planning --repo ../myproject --name "My Project" --prefix MP
npm run build                     # web UI
npm start -- ../myproject-planning   # http://127.0.0.1:4300
```

Requirements: Node 24, git, the GitHub CLI (`gh`, authenticated) and Claude
Code (`claude`, logged in). The engine starts in `dry-run`; flip `engine.mode`
to `live` in Settings once you have watched a dry run.

## Authentication and billing

Worker sessions are Claude Code sessions launched through the official Agent SDK.
By default they use whatever `claude` is logged in as. Anthropic's Agent SDK docs
ask that SDK-built agents use **API-key authentication** rather than a claude.ai
login, and the SDK is governed by the Commercial Terms — so set an Anthropic
Console key (Settings → *This machine* → Anthropic API key, stored in the
gitignored `planestro.local.yml`, or `ANTHROPIC_API_KEY` in the environment) to
bill the API directly. Never offer a claude.ai login to other users of a tool
built on this.

## Lifecycle

```
NOT_YET_SUBMITTED → QUEUED → PLAN_IN_PROGRESS → PLAN_READY → IN_PROGRESS → IN_REVIEW → MERGED → FINISHED
                                  (planner)     (you approve)  (implementer)   (rebase, CI, merge)  (cleanup)
```

`ICEBOX` holds ideas; `blocked` / `awaiting` are orthogonal flags so an item never
loses its phase when it needs you. Epics own a `feature/<slug>` integration branch
for chained children; externally driven items (e.g. another agent) are watched.

## Layout

```
packages/shared   schema, item/prompt file codecs, ranks, transitions, placeholders
packages/server   store (atomic writes, journal, semantic commits), engine (ports,
                  policy, lifecycle, SDK session port), Hono API + WebSocket, CLI
packages/web      React + Vite UI: board, item, sessions, prompts, settings
docs/sdk-notes.md what the Claude Agent SDK spike validated and the gotchas
spikes/           the runnable Phase 0 spike
```

`npm test` runs the vitest suites (file codecs, ranks, transitions, store,
migrations, and the engine lifecycle on dry-run ports, including CI-red,
rebase-conflict, parked question/permission and restart recovery scenarios).

## Data dir editing rules

Hand-edit freely while planestro is not running — it commits your edits as
`manual: …` at startup. While it runs, planestro is the only writer; worker
sessions never touch the files either: they use the `submit_plan`, `add_note`,
`append_activity`, `report_done` and `report_blocked` tools instead.
