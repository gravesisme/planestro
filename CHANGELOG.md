# Changelog

## Unreleased

### Fixed

- A command behind an assignment whose value is a variable (`for s in 1 3 7; do HH_SEED=$s ./tools/run_checks.sh x; done`)
  is judged as the command it runs, as `HH_SEED=3 ./tools/…` always was: it no longer parks under a rule that covers it
  (HH-625 parked seven times in half an hour), and it no longer hides a denied command (`X=$y gh pr create`) or a heavy
  run from the `run_heavy` redirect (#515).

### Added

- The operator MCP endpoint offers `submit_item` and `move_item` behind a new opt-in,
  `operator_mcp.allow_submit`: your own Claude Code or Codex session can queue an item, plan an
  epic's breakdown, park an item that has not started in the Icebox or bring one back, and reorder
  a column, each as the board does it and recorded as `[operator]`. While an opt-in is off, the
  endpoint's instructions name it, so a session says which setting would offer a tool instead of
  calling planestro's HTTP API, where its change would read as yours.

## 1.1.0 — 2026-10-28

### Fixed

- A worker could read any file on the machine with `git diff --no-index <path>`, and write outside its
  worktree with an abbreviated `git diff --outp=<path>`: both slipped past the deny under the built-in
  `git diff` / `git log` / `git show` rules. `--no-index` and `--output` are now denied in every form, and a
  rule check can no longer allow a command the git deny refuses (#508, #503).
- `unblock_item` with a message on an epic past its breakdown no longer reports "the session resumes"
  while dropping the message: it is refused in words, the stop is kept, and the reply says what works
  (a fix child for a red epic in review, `rerun_ci` for a flake). Your own **Unblock** refuses the same way,
  in plain words. A fix child filed for a red epic takes it back in progress and clears its CI stop, so the
  reused PR is driven again (#505, #500).
- Read-only work inside a worker's own worktree no longer parks for a permission ruling: the Read, Grep
  and Glob tools there and in scratch folders (symlinks followed), `sed` / `awk` whose script only prints,
  and git readers (`status`, `diff`, `show`, `log`, `ls-files`, `ls-tree`, `blame`, `cat-file`, …).
  Secrets and every deny still come first; writes, `xargs`, `python3 -c` and paths outside the worktree
  still ask (#508, #503).
- A harness that runs longer than the CLI's 10-minute foreground Bash cap has a home: `run_heavy` is offered
  in every work turn, holds one run of any length (up to `heavy_runs.timeout_min`), and is not stopped by
  the quiet-turn watchdog. A Bash call that hits the cap is pointed at it, and the orchestrator counts either
  `run_heavy` or one background harness followed with Monitor as a single foreground run (#507, #502).

### Added

- `secret_env` in planestro.local.yml hands a worker a value from a secret file by name, never the file:
  `ELEVENLABS_API_KEY: { file: .env.local }` puts that one key in the environment of implement and fix
  turns and their `run_heavy` commands (never a planner's or the orchestrator's). It is hand-edited only,
  values never reach a prompt, the journal, Activity or an item file, and command output is redacted. A
  refused secret read names the variables the session already has, and a plan that names a secret file is
  flagged when it is handed in (#506, #501).
- Feedback notes carry a title of at most 72 characters, like a commit subject. The Console shows it in
  bold above the note, held to two lines until clicked, and a filed issue takes it as its title. Older
  notes read their first sentence (#504).

### Changed

- `planestro.local.yml` and `~/.planestro/policy.yml` are on the secret-file deny list: no worker reads or
  writes them by any tool or ruling, so nothing a model calls can sanction itself a secret (#506).
- `heavy_runs.enabled` now only turns on turn-taking (one heavy run at a time, waiting on CI for shared
  runners); `run_heavy` itself is always there (#507).

## 1.0.2 — 2026-10-27

### Fixed

- The Claude Code plugin's MCP server reaches the session's own project, not whatever server holds port
  4300: a small stdio bridge finds the project's data dir and its running server, and refuses a server
  that serves another project. `PLANESTRO_URL` still overrides (#497).
- `serve --watch` no longer restarts under a live turn when one status poll goes unanswered; it waits,
  and restarts anyway only after two minutes of silence. A "lost connection" left by an earlier turn
  clears at the next turn's first planestro call that answers (#493, #494).
- Two `--watch` servers on one checkout no longer lose the web UI when both rebuild it after a pull; a
  server that started without a UI serves it once a build lands (#490).
- A worker's `report_blocked` is refused while messages from you wait for its session: they go as its next
  turn instead of being left unread under a block (#495, #491).
- A rebase a session resolved is checked against the base tip it was rebased onto, so a base that moved
  meanwhile no longer reads as a failed rebase (#488, #485).
- `unblock_item` with `sync_first` and a message delivers the message to an in-review session (#487, #486).
- The "needs you" button reads "1 item needs you" to a screen reader, not "1 items need you".

### Added

- The operator MCP endpoint offers `list_notes`, `edit_item` and `mark_note` (with `allow_writes`),
  `file_note` (with `allow_actions`), and, behind a new opt-in `operator_mcp.allow_decisions`,
  `approve_plan`, `reject_plan`, `discard_item` and `close_as_done`, each recorded as `[operator]` (#496).
- Codex exec workers can attach pictures and request an audition through their final message (#495, #491).
- Settings → Orchestrator lists every daily efficiency audit run, and an audit whose biggest waste was
  already filed or handled records "nothing new" instead of filing the note again (#489).
- When your GitHub login maintains planestro, "File notes as issues in" offers its tracker in one
  click (#492).
- A browser test suite (`npm run e2e`, Playwright, run in CI): the board, the item page and an item
  driven from queue through plan approval to merged in Chromium against the sample, and both pages at
  phone width (#483).

## 1.0.1 — 2026-10-21

### Fixed

- Continuing a rebase after a session resolved its conflict no longer fails when the branch
  deletes files: those paths were named to `git add` and the item blocked `engine_error` (#477).
- A Claude worker may write scratch files with Write/Edit where Bash already could (`/tmp`,
  `$TMPDIR`), so drafting a commit message there is no longer denied (#475).
- A Claude orchestrator wake no longer prints `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` to the server log (#473).
- Usage page: a range with no dollars opens on Tokens; "turns and wakes" is worded the same in the
  header and the day line; sub-headings are spaced; heaviest starting context gives each item's
  session count (#476).

### Changed

- Claude Code 2.1.306 with `@anthropic-ai/claude-agent-sdk` 0.3.306 is the validated pair (#474); a start
  with 2.1.306 no longer warns that the CLI drifted.

## 1.0.0 — 2026-10-21

The first public release. planestro is used daily to build
[Hurricane Harrison](https://hurricaneharrison.com), a game on the App Store.

### What it does

- **A backlog that ships itself, with you at the decision points.** Write an item in markdown
  and queue it. An agent proposes a plan; you approve it. The agent implements it on its own
  branch and worktree; planestro opens the pull request, waits for CI, rebases when the base
  moves, merges and cleans up.
- **Claude Code or Codex, per item.** Either can plan, implement and orchestrate, on the CLI
  logins you already have. A mixed fleet (say Codex for art, Claude for code) works too.
- **Nothing waits on a human.** A plan to approve, a question or a permission request is
  saved and the session parks. Answer whenever, even after a restart.
- **Git mechanics belong in code.** Branches, CI polling, the merge queue and cleanup are
  deterministic. Cleanup needs evidence the work landed; anything unexpected is kept.
- **Epics** split a feature into child items that merge through an integration branch.
- **Your data stays local.** Items, plans and activity are files in a git-versioned
  planning folder. [What leaves your machine](docs/what-planestro-sends.md) is listed.
- **A sample to try first:** `npm run sample` runs the whole lifecycle with simulated
  agents, git and GitHub. No repository, GitHub or agent login needed.

### Supported

- macOS (used daily). Linux runs the test suite in CI. Windows is untested.
- Node 24, git, the GitHub CLI, and GitHub with CI.
- Claude Code 2.1.305 or later with `@anthropic-ai/claude-agent-sdk` 0.3.305, and/or
  the Codex CLI 0.154.0 (app-server transport for planning and orchestration).
- One user, one project per server process, on this machine. Other devices on a network
  you trust must be paired first (`planestro pair`).
- Data dirs are upgraded by `planestro migrate`; a newer data dir opens read-only in an
  older planestro.

### Known limitations

- A Claude worker asks before any command your permission rules don't cover, so the first
  test run waits for you unless you allow it (see [Getting started](docs/getting-started.md)).
- Codex reports tokens, not dollars, so its spend is budgeted in tokens and turns.
- planestro warns at startup when the installed Claude Code is newer than the version
  bundled with the Agent SDK it was validated against.
- The web package has no browser test suite; the UI is checked by hand.

### Verified for this release

Live acceptance runs on the release candidate, one Claude-only and one Codex-only (app-server),
in a throwaway repository with real pull requests and CI: plan approval with a review hold,
implementation, CI, release of the hold, merge and cleanup; a pending decision across a server
restart; pause and resume; a red CI run fixed by the worker; refusal to delete unexpected
files in a worktree; and an epic merging through its integration branch.
