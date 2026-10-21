# Changelog

## Unreleased

- Claude Code 2.1.306 with `@anthropic-ai/claude-agent-sdk` 0.3.306 is the validated pair (#474); a start
  with 2.1.306 no longer warns that the CLI drifted.
- A Claude orchestrator wake no longer prints `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` to the server log (#473).

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
