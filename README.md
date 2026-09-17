# planestro

[![CI](https://github.com/gravesisme/planestro/actions/workflows/ci.yml/badge.svg)](https://github.com/gravesisme/planestro/actions/workflows/ci.yml)

**A backlog that ships itself — with you as the conductor.** Local-first
planning and agent orchestration for a solo developer: [Claude Code](https://claude.com/claude-code)
plans and writes the code, the [Codex CLI](https://developers.openai.com/codex/cli) draws the art,
and one feature can need both.

You write backlog items as markdown. planestro turns **Queue** into a plan you
approve, an implementation on its own branch and worktree, a pull request, a
rebase, a CI wait, a merge and a cleanup — a Claude session doing the thinking,
deterministic code doing everything mechanical. When something needs a human,
the session is parked and you are told; answer whenever, and the same session
resumes with its context intact.

![One feature on the board: two art children drawn by Codex wait for a look, the code children wait for the art, the epic counts 0/4](docs/img/board.png)

**[Read the manual →](docs/README.md)**

It is used daily to build a commercial game that ships on the App Store:
several agents working in parallel worktrees, every change through a reviewed
plan, a pull request and green CI.

## Try it in a minute — no repo, no GitHub, no Claude login

```sh
git clone https://github.com/gravesisme/planestro && cd planestro
npm install && npm run build
npm run sample          # http://127.0.0.1:4310
```

`sample` builds a fictional project (*tidepool*, a tide-times CLI) with a full
backlog — finished work with its history, a reviewed piece of art, a bug with
repro notes, two epics, an icebox, prompt templates for both agents — and
serves it with the engine in **dry-run**. Git, GitHub and both agents are the
in-memory fakes the test suite drives, so the whole lifecycle really runs:

1. Drag a card from **NOT YET SUBMITTED** to **QUEUED**. A worktree is
   "created" and a plan appears; the card turns red: it needs you.
2. Open it, read the plan, **Approve & implement**.
3. Watch it open a PR, wait for CI, merge, clean up and land in **Done**. The
   Console tab shows every `Would …` the real engine would have run.

4. Open the **Tide chart view** epic → **plan the breakdown**, and follow
   [two agents, one feature](#two-agents-one-feature) below.

`npm run sample -- --reset` rebuilds it from scratch.

![An item parked on plan approval](docs/img/item.png)

## Two agents, one feature

Some features need pictures *and* code. Write one epic; the Claude planner
proposes the children, routes the raster art to a Codex model and the code to a
Claude model, and makes the code wait for the art. Code checks the list (known
implementers, no cycles) before you ever see it; you edit it and approve.

![Six frames from the sample: the epic, its proposed breakdown, art waiting for review on the board, the review, the code child starting once the art merged, everything in Done](docs/img/walkthrough.gif)

![The proposed breakdown: two Codex art children, two Claude code children that wait on them](docs/img/breakdown.png)

Codex draws in its own worktree and commits. The pull request goes through sync
and CI like any other — then, instead of merging, it **parks for your eye**:
before/after thumbnails from git, approve, or send it back to the same Codex
thread with a note and a pasted screenshot.

![An art item waiting for review: the image the branch added, on a checkerboard](docs/img/review.png)

Only when the art has merged do the code children start — their worktrees cut
from a branch that already holds the PNGs, their prompts listing exactly which
files were delivered. Then the epic lands as one pull request.
[The walkthrough →](docs/mixed-agent-epics.md)

The two agents are trusted differently, and the tool says so: a Claude worker
asks before anything unusual (a per-command policy, parked permission requests);
a Codex worker cannot ask, so it runs in a sandbox that cannot write outside its
worktree or reach the network. [Agents →](docs/agents.md)

## Why it is built this way

The interesting part is not that an LLM writes code; it is everything around
it that has to be boring and correct. The rules the codebase is held to (the
full list, with reasons, is in [`CLAUDE.md`](CLAUDE.md)):

- **Files are the truth.** One markdown file per item (YAML frontmatter +
  `# Description`, `# Notes`, `# Plan`, `# Activity`), a prompt library,
  small attachments and an NDJSON journal, in a git-versioned *data dir* with
  meaningful commits (`TD-6: approve plan`). Readable, greppable and editable
  without the tool.
- **Don't ask an LLM what a state machine can know.** Git, worktrees, GitHub,
  CI polling, transitions, persistence, cleanup and scheduling are code.
  Claude plans, implements and makes judgment calls — it never polls.
- **No process ever waits on a human.** Plan approval, a permission prompt or
  an agent's question parks the session: the request is persisted, the turn
  ends, the process exits, and the UI shows **NEEDS YOU**. Your answer resumes
  the same conversation — after a restart, too.
- **Claude is never the sole holder of anything needed to recover.** Every
  turn is rendered from persisted state; a reconciler cross-checks that state
  against the real world at startup and converges crash leftovers.
- **Destructive operations require positive evidence.** Nothing is deleted
  because state says it should be safe: cleanup needs a fresh fetch, the PR
  reported merged, and the tip proven reachable from the base. Ambiguity
  blocks with a reason; it never deletes.
- **Dry-run and a big red lever.** `engine.mode: dry-run` logs `Would …`
  instead of acting, and **PAUSE AUTOMATION** stops everything new after the
  current safe operation, across restarts.
- **Project-neutral.** A project is `{code_repo, data_dir}`. The data dir can
  live anywhere — for example an orphan branch of the code repo checked out as
  a nested worktree, so planning history never touches the code's branches.

## Lifecycle

```
NOT_YET_SUBMITTED → QUEUED → PLAN_IN_PROGRESS → PLAN_READY → IN_PROGRESS → IN_REVIEW → MERGED → FINISHED
                                  (planner)     (you approve)  (implementer)   (rebase, CI, merge)  (cleanup)
```

`ICEBOX` holds ideas; `blocked` / `awaiting` are orthogonal flags, so an item
never loses its phase when it needs you. Epics own a `feature/<slug>`
integration branch for chained children; items driven by something else
(another agent, a colleague) are watched rather than run. **Close as done**
finishes an item whose work landed some other way, without a PR.

An orchestrator session (a separate, freely rotated Claude conversation) wakes
on the ambiguous events — a plan to review, a second red CI run, a conflict —
and can instruct workers or escalate to you; it never owns state.

## Using it on your own project

```sh
npm install && npm run build
npx tsx packages/server/src/cli.ts init ../myproject-planning --repo ../myproject --name "My Project" --prefix MP
npm start -- ../myproject-planning --open     # http://127.0.0.1:4300
```

Requirements: Node 24, git, the GitHub CLI (`gh`, authenticated) and Claude
Code (`claude`, logged in); the Codex CLI (`codex`, logged in) if you route work
to it. The engine starts in `dry-run`; flip `engine.mode`
to `live` in Settings once you have watched a dry run against your repo.
Project rules come from your repo's own `CLAUDE.md` / `AGENTS.md`; planestro
adds nothing project-specific.

`serve --watch` is for working on planestro itself: web source changes rebuild
the UI and open pages reload; server changes restart it between agent turns
(automation is paused until running turns finish, then resumed).

> **The web UI has no authentication.** It binds to `127.0.0.1` by default and
> can start agents that edit and push code. `--host 0.0.0.0` exposes that to
> your network; only do it on a network you trust.

### Authentication and billing

Worker sessions are Claude Code sessions launched through the official Agent
SDK. By default they use whatever `claude` is logged in as. Anthropic's Agent
SDK docs ask that SDK-built agents use **API-key authentication** rather than a
claude.ai login, and the SDK is governed by the Commercial Terms — so set an
Anthropic Console key (Settings → *This machine* → Anthropic API key, stored in
the gitignored `planestro.local.yml`, or `ANTHROPIC_API_KEY` in the
environment) to bill the API directly. Never offer a claude.ai login to other
users of a tool built on this.

### What agents may do

Workers run with a permission policy (`packages/server/src/engine/policy.ts`):
pushes, PR operations and anything touching the base or release branches are
denied outright — integration is planestro's job, not the agent's — an allow
list covers the routine, and everything else parks as a permission request you
answer in the UI. A per-item budget (`budget_usd_per_item`) caps spend.

## Layout

```
packages/shared   schema, item/prompt file codecs, ranks, transitions, placeholders
packages/server   store (atomic writes, journal, semantic commits), engine (ports,
                  policy, lifecycle, reconciler, orchestrator, SDK session port),
                  Hono API + WebSocket, CLI, the sample project
packages/web      React + Vite UI: board, item, sessions, prompts, console, settings
docs/             the manual (start at docs/README.md); spike records in docs/notes/
spikes/           the runnable Phase 0 spike
```

The engine talks to the world only through four ports (git, GitHub, processes,
agents — Claude and Codex behind one contract). Live ports shell out; dry-run ports are an in-memory world. That seam
is why `npm test` can drive the real lifecycle — CI red then fixed, a rebase
conflict handed to the session, parked questions and permissions, a restart in
the middle of a turn, crash markers left on disk — in about twenty seconds with
no network.

```sh
npm test            # vitest
npm run typecheck
```

## Data dir editing rules

Hand-edit freely while planestro is not running — it commits your edits as
`manual: …` at startup. While it runs, planestro is the only writer; worker
sessions never touch the files either: they use the `submit_plan`, `add_note`,
`append_activity`, `report_done` and `report_blocked` tools instead. Schema
changes ship as migrations (`planestro migrate <data_dir>`); an older dir
opens read-only until you run it, a newer one until you upgrade the tool.

## Status

A working tool built for one person's workflow, shared as-is. Developed and
used on macOS; Linux runs the test suite in CI; Windows is untried. One project
per server process. The Claude Code and Agent SDK versions it was validated
against are pinned in `packages/server/src/compat.ts`, and it warns when the
installed CLI has drifted.

## License

[MIT](LICENSE)
