# Getting started

## Requirements

- Node 24, git (with a `user.name` and `user.email`). macOS and Linux.
- For real work: the GitHub CLI (`gh`, authenticated) and the agent CLI for each runner your
  models use: Claude Code (`claude`, logged in), the Codex CLI (`codex`, logged in), or both.
  `planestro check <data_dir> --preflight` lists what is missing, each with its repair.
- None of those for the sample: it runs on in-memory fakes.

```sh
git clone https://github.com/gravesisme/planestro && cd planestro
npm install && npm run build
```

## The one-minute sample

```sh
npm run sample            # http://127.0.0.1:4310, opens a browser
npm run sample -- --reset # rebuild it from scratch
```

`sample` creates a fictional project, *tidepool* (a tide-times CLI), under
`.planestro/sample/`, with a backlog that shows every part of the tool:

| In the sample | Shows |
|---|---|
| Three finished code items, one with a CI failure that was fixed | The Done lane and an item's full history |
| **App icon** — a finished item drawn by the art model, sent back once | Art review: what the log of a reviewed picture looks like |
| **Tide chart view** — an epic with no children yet | **Plan the breakdown**: the planner proposes children and routes them to Claude or Codex |
| **Offline mode** — an epic with hand-written children, one waiting on the other | Dependencies without the planner |
| A bug with repro notes, a docs item, two icebox ideas | Ordinary backlog |
| Prompts → ★ Favorites | Starting an item from a Claude or a Codex prompt template |

The engine is in **dry-run**: git, GitHub and both agents are fakes, but the lifecycle is
the real code. Try, in order:

1. Drag **Times are wrong…** from NOT YET SUBMITTED to QUEUED. A plan appears; the card
   turns red: it needs you. Open it, **Approve & implement**, and watch it reach Done. The
   Console tab shows every `Would …` a live engine would have run.
2. Open **Tide chart view** → **plan the breakdown**. Edit the proposed children if you
   like, **Approve & create**. The two art children are planned, drawn (placeholder
   pictures in dry-run) and **park for your review** with thumbnails; the code children
   stay QUEUED until you approve the art. Then they start, already told which files the
   art delivered.

Dry-run state is rebuilt from the item files at startup, so restarting the sample keeps
what you did.

## Your own project

```sh
npx tsx packages/server/src/cli.ts init ../myproject-planning --repo ../myproject --name "My Project" --prefix MP
npm start -- ../myproject-planning --open       # http://127.0.0.1:4300
```

`init` creates a *data dir*: `planestro.yml`, `items/`, `prompts/` (a copy of the shipped
prompt library, yours to edit), `attachments/`, `journal/`. A separate sibling folder, as
above, is the recommended layout: `init` makes it a git repository of its own when it is not
one and commits the seed files, so planning history never touches the code's branches. Keep
any remote for it private. The base branch is the code repo's `origin/HEAD`, else the branch
checked out (it says so); pass `--default-branch` to choose another. `--layout orphan-branch`
expects the orphan branch already checked out as a worktree at the data dir: `init` writes the
files and keeps the folder out of the code repo's status, nothing more.
Re-running `init` on an existing data dir adds files that are missing (new shipped prompts
after an upgrade) and never overwrites one.

Then:

1. **Settings** — check the base branch, models and categories. The engine starts in
   `dry-run`; queue an item and read the Console to see exactly what it would do to *your*
   repository.
2. Switch `engine.mode` to `live`, then **restart the server**: the mode is read at startup,
   and the header shows the one running. Until then it is still simulating.
3. Write an item (or start one from a prompt), queue it, approve its plan.

To add an art model, see [Agents](agents.md#adding-a-codex-model). Project rules —
conventions, how to run the tests, where assets live — belong in your repository's own
`CLAUDE.md` / `AGENTS.md`; both agents read them. planestro adds nothing project-specific.

> **The web UI has no authentication.** It binds to `127.0.0.1` and can start agents that
> edit and push code. Other websites can't drive it, but `--host 0.0.0.0` exposes it to your
> network. See [SECURITY.md](../SECURITY.md).
