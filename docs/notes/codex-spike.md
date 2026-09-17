# Codex CLI spike — findings

Validated on **2026-09-17** against **codex-cli 0.154.0** (macOS, a logged-in ChatGPT
account), in throwaway repositories. Runner: `npm run spike:codex -- <step>`
(`spikes/codex-spike.ts`); live end-to-end runs: `npm run spike:codex-live -- item|review|epic`
(`spikes/codex-live.ts`: the real engine, real git against a local bare remote, the real
Codex CLI; only GitHub and the Claude side are stand-ins). `packages/server/src/compat.ts`
pins the version so planestro can warn when the installed CLI drifts.

| # | Question | Result | Notes |
|---|---|---|---|
| a | Does `codex exec` run fully headless? | **PASS** | **Close stdin** (`stdio: ['ignore', …]`): with a pipe for stdin it prints `Reading additional input from stdin...` and waits forever. With stdin ignored it prints that line once and proceeds. |
| b | Machine-readable progress? | **PASS** | `--json` streams NDJSON: `thread.started{thread_id}`, `turn.started`, `item.started` / `item.completed` with `item.type` `agent_message{text}` or `command_execution{command, aggregated_output, exit_code, status}`, `turn.completed{usage}`. Image generation appears as ordinary `command_execution` items (the agent reads its imagegen skill, then copies the PNG out of `~/.codex/generated_images/<thread_id>/`). |
| c | A structured "done / blocked / question" without MCP? | **PASS** | `--output-schema` constrains the final message; `-o` writes it to a file. Stands in for `report_done` / `report_blocked` / a parked question. |
| d | Can it commit inside a git worktree under the sandbox? | **PASS** | `-s workspace-write -C <worktree>` created files and committed, including in a linked worktree whose git dir lives in the main repository. Writes elsewhere fail `operation not permitted`; network fails `Could not resolve host`. No prompt, no hang. |
| e | Resume the same conversation later? | **PASS, but the sandbox is not resumed** | `codex exec resume <thread_id> "<prompt>"` recalls earlier turns. Found by the live acceptance run: with `--ignore-user-config` the resumed thread comes back **read-only** and reports it cannot save or commit. `resume` has no `-s`; `-c sandbox_mode="workspace-write"` works on both forms, so the port always passes it. (The first spike missed this because the author's personal config sets workspace-write.) |
| f | Image generation headless? | **PASS** | The built-in image tool works in `exec`, no API key, no flag: 1254×1254 RGBA with real transparency; resized and committed by the agent on request. |
| g | Image-to-image with `-i ref.png`? | **PASS, with a caveat** | The tool *edits from* the attached image: same subject, pose, lighting, framing; recoloured as asked. It is a strongly guided regeneration, not a pixel-preserving edit (surface texture changed). Anything that must stay pixel-exact still needs the project's own deterministic finishing step. |
| h | Killed mid-turn | **PASS, note the exit code** | SIGTERM ends the process with **exit 0** and no final message: "killed" is what the port remembers, not what Codex reports, and *exit 0 without a final message* is an incomplete turn. Resuming afterwards works; stderr logs one harmless `Custom tool call output is missing`. |
| i | Resuming a thread that does not exist | **PASS** | Exit 1 at once, stderr `thread/resume failed: no rollout found for thread id …` → `session_lost`. |
| j | Config isolation | **PASS** | `--ignore-user-config` keeps the login and still reads the repo's `AGENTS.md`, while dropping the user's MCP servers (whose auth failures otherwise spam stderr). |
| k | `--add-dir` | **do not use** | It grants *write* access. Reads outside the workspace are already allowed; a worker must never be able to write the data dir. |
| l | Cost accounting | **PARTIAL** | `turn.completed.usage` is tokens (input / cached / output / reasoning), never dollars. A live art turn used 20–35k uncached tokens; budgets for Codex items are turns and tokens. |
| m | Over-obedience | note | Told "never work around a sandbox refusal", Codex reported `blocked` when an *optional* check's cache write was refused. Told to "match the existing art" in a repository with none, it asked for a reference instead of guessing. Both are right; both were fixed in the prompt, not the port. |

Still unprovoked, so unverified: an expired login and a rate limit. The port classifies
them from stderr patterns (`auth_required`, `rate_limited`); a real occurrence should
confirm the patterns.
