# Switching providers

Switch when one subscription runs out, when you want a different model's judgment, or when you want a Codex-only setup. Switching is explicit: Planestro does not automatically move work between providers.

Open **Settings → Switch provider**, or use the usage banner. The banner offers the other provider when it has an available configured model. Choose Claude or Codex, then a model with planning capability. You can change the orchestrator, defaults for new items, and selected unfinished items independently.

**Preview changes** explains each selected item in one line, including what it is waiting for if it cannot switch. **Save changes** keeps the global automation setting. **Save and resume automation** also releases the global pause. The result lists applied, skipped and failed items; retrying a partially completed batch does not repeat completed changes.

## What carries over

The same item keeps its lifecycle status, worktree, branch, commits, uncommitted edits, PR, merge and review holds, approvals and their conditions, dependencies, and budgets. No worktree is recreated and setup hooks are not rerun. Changing an epic's planner changes future planning and child-planner inheritance; select existing children individually.

The conversation itself does not cross providers. The next session starts with a **fresh brief** built from the current item file and git, including notes, attachments, pending messages, approved instructions, commits, dirty files, PR/CI state and unfinished git operations. Switching back also starts fresh: Claude → Codex → Claude never resumes the original Claude conversation.

Approval and permission questions remain pending. An answer is carried with the original question in the persisted item record, never as an isolated answer.

Codex native sandbox requests are recorded and immediately declined so no process waits for you. They cannot be granted through **Allow once** or **Always allow** in a later turn. Choose **Deny** and give another approach, or take the item over, perform the action yourself and hand it back. Permissions for configured external MCP tools still follow their own rules and call budgets.

## Items that must wait

- A live turn or engine operation must finish before its item can switch.
- An item taken over by a person must be handed back first.
- Finished, merged and iceboxed items are outside this screen's unfinished backlog.
- An unavailable destination model cannot be selected.

Existing art workers keep their model and `exec` transport. If an item is already implementing or in review, changing only its planner affects future planning; it does not start another turn or save an old task for that future plan. The bulk switch can change their planner, but never silently moves their implementation or existing PR to the general-purpose Codex transport. App-server image generation and image-to-image are not enabled.

## Budgets and usage pauses

Claude uses dollar budgets. With a subscription these are an API-price yardstick, not a separate bill. Codex uses turn and token budgets; its dollar cost is **not reported**, never zero. Historical Claude costs remain recorded.

All token limits count `max(0, input_tokens - cached_input_tokens) + output_tokens`. Defaults are 600,000 per item, 100,000 per planning turn, 50,000 per resumed orchestrator wake and 200,000 per fresh wake. A capped planner gets one hand-in attempt with at most 10,000 more tokens, still within the item budget. Limits remain configurable. Usage notifications arrive after model responses, so one in-flight response can overshoot a cap. The art `exec` transport reports usage only after its turn completes: Planestro records that usage and applies its final report, then checks the item budget before any later turn.

A provider usage pause stops that provider's new turns. Already requested instructions, answers and permission rulings are saved on their items and resume when admission is allowed, including after a restart. A PR awaiting such an instruction is not merged over it. Other providers can work, and deterministic CI/merge work continues while global automation is enabled. Neither saving a switch nor resuming global automation clears a provider guard. **Retry provider** overrides only that provider's crossing. With `usage_guard.auto_resume`, a guard releases 60 seconds after its reported reset; a user or disk pause remains.

Codex quota telemetry is not assumed from protocol types. Without verified readings, model-specific unavailability is used; no utilization percentage or reset time is invented.

An item with a saved instruction shows **waiting: saved instruction** on its board card. Hover over it for the reason: a pause, a missing or unavailable model, an incompatible phase, or another admission requirement. Saved turns honor the item's **Allow model fallback** setting, but a fallback cannot bypass a provider usage pause. If its phase or model no longer fits, review the item's status and model; the instruction stays saved instead of running in the wrong phase.

After a restart, an interrupted turn receives its original saved instruction in its existing conversation, when that session is compatible. This intentionally preserves answers and permission rulings instead of replacing them with a generic “carry on.” It is not a new provider handoff: the conversation still contains the work already done. A provider switch still uses the fresh brief described above.

## Orchestrator changes

The current wake finishes with its selected model. The change applies on the **next wake, with no server restart**. A provider change starts a fresh orchestrator conversation built from persisted project state. A capped wake runs the normal end-of-wake hooks; it does not persist or replay its batch.

## Codex-only setup

Install the Codex CLI and sign in with `codex login`. Node 24, git and authenticated GitHub CLI are still needed for Planestro's deterministic mechanics. Claude need not be installed or authenticated.

In Settings → Models, add the **Codex GPT-6 Astra preset**, or configure an ordinary model row:

```yaml
models:
  - id: codex-gpt-6-astra
    label: Codex GPT-6 Astra
    runner: codex
    codex_model: gpt-6-astra
    codex_transport: app-server
    engine_commits: true
defaults:
  planner: codex-gpt-6-astra
  implementer: codex-gpt-6-astra
  category: Tools # choose a category configured in your project
orchestrator:
  model: codex-gpt-6-astra
```

Keep your other project settings. The model ID is configurable; choose one available to your Codex account. Existing Codex rows without `codex_transport` continue to use `exec` and cannot plan or orchestrate. Use Switch provider for existing unfinished work as well as defaults.

Planestro keeps its app-server threads in a dedicated Codex home (`~/.planestro/codex`) and seeds it from the existing login once. Codex then manages refreshed credentials there; later turns do not overwrite them. If that dedicated login expires or you need to change accounts, stop Planestro and run `CODEX_HOME="$HOME/.planestro/codex" codex login`, then restart Planestro. Personal MCP servers and external-service credentials are not handed to the model process. Configured external MCP tools run through Planestro's scoped bridge, with permission and call-budget checks.

Signing in again in your normal `~/.codex` home does not update this dedicated login. Use the command above for Planestro; copying credentials on every turn would overwrite refreshes made by its own Codex process.

Schema v4 changes session IDs in `agent_sessions` into records. Older Planestro checkouts open the migrated data directory read-only; upgrade those checkouts before using it.
