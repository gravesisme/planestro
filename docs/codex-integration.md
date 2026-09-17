# Codex as a second worker — spike findings and design

Goal: one epic, planned once by the Claude planner, whose **art children run on
the Codex CLI** and whose **logic children run on Claude Code**, with the logic
blocked on the art — all driven by planestro.

Status: spike done 2026-09-17, nothing built. The staged plan — milestones,
acceptance tests, open decisions — is in [`codex-epic-plan.md`](codex-epic-plan.md);
this file holds the findings and the design it stages.

## What the spike validated

`codex-cli 0.154.0`, macOS, a throwaway git repo, logged-in ChatGPT account.

| # | Question | Result | Notes |
|---|---|---|---|
| a | Does `codex exec` run fully headless? | **PASS** | **Close stdin** (`< /dev/null`, or `stdio: ['ignore', …]`): with a pipe for stdin it prints `Reading additional input from stdin...` and waits forever. This cost the first spike run five minutes. |
| b | Machine-readable progress? | **PASS** | `--json` streams NDJSON: `thread.started {thread_id}`, `turn.started`, `item.started` / `item.completed` with `item.type` ∈ `agent_message`, `command_execution` (with `.command`), …, then `turn.completed {usage}`. Enough for the console view and for `lastOutput`. |
| c | A structured "done / blocked / question" without MCP? | **PASS** | `--output-schema schema.json` constrains the final message; `-o last.json` writes it to a file. `{"outcome":"done","summary":"…","question":null}` came back exactly. This replaces `report_done` / `report_blocked` / a parked question for a worker that has no planestro tools. |
| d | Can it commit inside a worktree under the sandbox? | **PASS** | `-s workspace-write -C <worktree>`: created a file and committed it. The sandbox confines writes to the workspace and cuts the network for model-run commands, so `git push` cannot succeed even if attempted. |
| e | Resume the same conversation later? | **PASS** | `codex exec resume <thread_id> "<prompt>"` recalled the codeword from the first turn. Same park/resume shape as Claude sessions: persist `thread_id` as the item's `session_id`. |
| f | **Image generation headless?** | **PASS** | The built-in image tool works in `exec`. The PNG lands in `~/.codex/generated_images/<thread_id>/…png`; the agent copied it into the worktree itself (1254×1254 RGBA, real transparency). No API key, no extra flag. |
| g | Cost accounting | **PARTIAL** | `turn.completed.usage` has token counts (input / cached / output / reasoning), no dollars. A trivial two-turn session read 127k and 260k input tokens (mostly cached) — budgets for Codex items should be in turns or tokens, not USD. |
| h | Noise | note | stderr carries `rmcp … AuthRequired` errors from the user's own configured MCP servers failing to auth. Harmless; pass `--ignore-user-config` or a dedicated `-p planestro` profile so a worker never inherits personal MCP servers, rules or hooks. |

Not yet tested: `-i <image>` for image-to-image (needed for repaint pipelines
that start from a rig render), how `exec` behaves when the model wants an
approval under `workspace-write` (there is no callback — expect a refusal in
the transcript rather than a prompt), long sessions, rate-limit errors.

## What planestro already has

- Per-item **planner** and **implementer** models — a Claude-planned,
  Codex-implemented item needs no new concept.
- **Epics** with a `feature/<slug>` integration branch, children that PR into
  it, and `depends_on` that unblocks on MERGED — "art blocks logic" is already
  expressible; the logic child's worktree is cut from the epic branch after
  the art merged into it, so it sees the assets.
- `external: true` models: items someone else drives, which planestro only
  **watches**. Codex items work this way today; this design replaces watching
  with running.
- The engine talks to agents through one port (`ClaudePort.runTurn`). The
  after-turn logic is already agent-agnostic: clean tree + commits ahead of the
  base ⇒ open the PR, *with or without* a `report_done`.
- A hold before merge (`skip_merge`) — the natural art-review gate.

## Design

### Phase 1 — `CodexPort`: Codex implements, Claude plans

- `ModelDef` gains `runner: 'claude' | 'codex'` (default `claude`) and
  `codex_model`. `Ports.claude` becomes `Ports.agents: Record<runner, AgentPort>`
  with the existing `runTurn` contract; the engine picks by the phase's model.
  A Codex model is never offered as a *planner* (no plan mode, no
  `submit_plan`) — the UI filters it like it filters external models today.
- `LiveCodexPort.runTurn`: spawn
  `codex exec [resume <id>] --json -s workspace-write -C <worktree> --add-dir <attachments> --output-schema … -o … --ignore-user-config -m <model>`
  with stdin ignored; map NDJSON to `onOutput`; on exit read the final message:
  `done` → `TurnResult.done`, `blocked` → `report_blocked`, `question` →
  park with `awaiting: question` (the answer resumes the thread). Abort signal
  → SIGTERM → `subtype: 'killed'`, resumable.
- Prompting: the `implement-plan` template is rendered as today and prefixed
  with a Codex-specific partial (`worker-system-codex`): commit on this branch,
  never push, end with the schema. Project rules come from the repo's own
  `AGENTS.md`, which Codex reads natively.
- Trust model differs and must be said out loud: Claude workers get a
  per-command policy with parked permission requests; a Codex worker gets a
  **sandbox** (workspace-only writes, no network for its commands) and
  planestro's after-turn verification. No per-command deny rules, no
  permission parking.
- Budget: `budget_turns_per_item` (or tokens) for Codex items;
  `budget_usd_per_item` stays Claude-only.
- Dry-run: `DryRunCodexPort` beside `DryRunClaudePort`; one engine test drives
  a Claude-planned / Codex-implemented item to FINISHED, one parks a question.
- `compat.ts` pins the validated `codex-cli` version like it pins Claude Code.

### Phase 2 — the planner breaks an epic down

- Queueing an **epic** runs a planning turn whose tool is `submit_breakdown`:
  a list of children `{title, description, runner-or-implementer, category,
  depends_on (by index)}` plus the epic-level plan. It parks on
  `awaiting: breakdown_approval`; the UI shows the proposed children as an
  editable list; approval creates them through the store and opens the epic.
- The planner prompt gets the routing rule as data, not folklore: which
  implementers exist and what each is for (from `models[].description`, e.g.
  "codex: all raster art; claude cannot generate images").

### Phase 3 — art is reviewed by eye

- Items from an art-capable runner default to `skip_merge` (hold after CI):
  the item page shows every image the branch adds or changes (git diff
  `--name-status` on image extensions, served from the worktree) as
  before/after thumbnails, with **Approve art** / **Request changes** (the
  latter resumes the Codex thread with your note and, optionally, an annotated
  screenshot via `-i`).
- The art prompt template carries the project's provenance rule (for the
  game: a `LICENSES.md` row per new asset source) so CI does not bounce it.

## Risks

- Codex CLI's flags and event names are younger and move faster than the
  Agent SDK's; pin the version, warn on drift, keep the parser tolerant.
- Large binaries on worker branches: fine for PNGs, worth a size guard.
- Two agents, one repo: art and logic children of one epic must not edit the
  same files — the breakdown prompt should say so, and `depends_on` enforces
  the order rather than hoping for a clean merge.
