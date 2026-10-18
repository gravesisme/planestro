# Public-release readiness and onboarding audit

Reviewed **2026-10-08**, against **`05be42709f371ce3c4cce6208bf9f2b64d46a7fd`**
(`05be427`, PR #315). This was the latest remote default-branch commit when the
fresh audit mirror was taken. One commit landed after the audit started; the
isolated worktree was advanced to include it and the final checks use that revision.
There are 98 commits and 256 changed files since the October 3 review's baseline,
`90f7dd1`.

This replaces the October 3 checklist. **Only this document was changed.**
Recommendations below are proposed work, not implemented features. No repository
settings, visibility, production planning data, marketing files, or DNS were changed.

## Recommendation

**Planestro is close to being suitable for an explicitly experimental public
source release. It is not yet a low-friction product launch.** The earlier
security/data-loss fixes are merged, the dependency audit is clean, and there
is substantial new recovery and usability work. The main remaining obstacles
are release controls, contradictory setup guidance, and a first-run process
that expects the new user to understand too much of the system.

Separate these decisions:

| Decision | Recommendation | Exit criteria |
| --- | --- | --- |
| Make the source public as an experimental, macOS-first tool | Conditional go after the short publication gate below | Review newly public material, repair the supported setup instructions, establish GitHub protections/reporting, and record limitations and release evidence. |
| Recommend unattended live use | Not yet established by this audit | A fresh-user live acceptance run for each advertised provider path, including pause/restart, a parked decision, CI, merge and cleanup. |
| Promote a polished agent orchestration product | Not yet | Guided setup, a clear first-task experience, current product demonstrations, and measured onboarding with people unfamiliar with the project. |

A desktop installer, npm publication, a new account system, a complete UI redesign,
and feature parity with another product are **not** prerequisites for opening
an experimental repository. Fix the misleading and broken entry paths first;
do not wait for every advanced feature or every cosmetic improvement.

## Second review — 2026-10-08, at `caa7433`

A second pass re-checked the findings below against **`caa7433`** (PR #329), 14
commits / 83 files after the audited revision (#203, #218, #219, #231, #234, #236,
#240, #242, #294, #295, #296, #297, #318). No tests, scans or probes were re-run.
The evidence table further down still describes `05be427`. Every repository-level
finding still holds at `caa7433`:

- `init` still falls back to `main` when `origin/HEAD` is missing (`init.ts`,
  `defaultBranchOf`). `orphan-branch` still only writes an exclude entry, and
  `.git/info/exclude` is still built by hand.
- The README and [Getting started](getting-started.md) still run `init` without
  `git init`. They still say "switch `engine.mode` to `live`" without a restart, and
  the README still lists Claude Code as required.
- The README still has two `--host 0.0.0.0 --watch` background examples.
  SECURITY.md still promises an access token "planned (see `docs/going-public.md`)",
  and still describes Codex only as sandboxed with no network.
- Both multipart routes (`routes/api.ts`, item and chat attachments) still call
  `formData()` with no body limit.

### Owner decisions (2026-10-08)

| Point | Decision |
| --- | --- |
| D1 | Agreed: the public opening is v1.0.0. |
| D2 | Five-developer study: agreed, not a gate. **Site redesign: wanted for 1.0** (P10). |
| D3 | Agreed: withdraw `orphan-branch`. |
| D4 | Agreed: a running-mode indicator. |
| D5 | **A setup check is in 1.0** (P7): local checks only, no model usage. |
| D6 | Resolved: existing logins only; key paths removed (P9, done). |
| A1 | Expanded below; hardening proposed as P11 and P12. |
| A2 | Document it: CI is Linux and the maintainer runs macOS. No macOS CI job. Raise the timeout. |
| A3, A4, A7 | Agreed. |
| A5 | A "what Planestro sends" page instead of a non-affiliation line (see A5). |
| A6 | The Crystal Cavern log is removed (done). |
| P3 | Resolved: SECURITY.md rewritten (done). |
| P8 | Not an issue: the release is the last step and stays a checklist. |

### Where this review disagrees

**D1 — Ship the public opening as v1.0.0. Don't open as "experimental" first.**
The site already says, in three places, that the repository becomes public
**with** v1.0.0. A separate experimental opening followed by a later 1.0 means
writing the release story twice. It also contradicts the published copy. The
maintainer's stated goal is a public v1.0.0 open-source release. Make the opening
*be* v1.0.0, with a narrow, written support contract:

- macOS (Linux CI-tested), Node 24, loopback only, single user;
- Claude-only and Codex-only setups; mixed projects documented as advanced;
- data-dir compatibility guaranteed through migrations (`SCHEMA_VERSION`), the
  only API that 1.x promises.

"1.0" in this sense means a stable contract, not a polished product. The three
tiers in the Recommendation table still apply, but the first row is the v1.0.0
gate. The second row (live use) is exercised by the maintainer's own acceptance
runs, not certified.

**D2 — The five-developer study and the site redesign are not v1.0.0 gates.**
They are good measures of adoption (O6, M1–M7) and belong after the release. For
a one-maintainer project, gating 1.0 on recruiting five unfamiliar developers adds
an open-ended dependency. Correct instructions and correct `init` behaviour remove
most of the friction it would measure. For 1.0, the site needs only what changes
at the flip: the CTA points at the public repo, prerequisites and cost are stated,
and the "coming soon / private" copy is updated (M2, M3 and the Pages checklist).

**D3 — Withdraw `--layout orphan-branch` rather than implementing it (O3).**
It is advertised but does nothing beyond an exclude entry. The separate sibling
planning repo is what every guide recommends. Implementing an orphan-branch layout
correctly (a second worktree of the code repo, planning commits that must never be
pushed by the engine's ref-locked git) adds risk to invariant 1 for a layout no
newcomer needs. Remove the flag, or make it fail with a pointer to the sibling
recipe, and keep the README's "can live anywhere" claim honest. It can return
later as a feature with its own tests.

**D4 — O2 needs instructions and a running-mode indicator, not a guided
enable-live flow, for 1.0.** The danger is that the UI reads "live" while the engine
is simulating. Two things fix that: the guide says to restart, and the header or
Settings shows *saved: live · running: dry-run — restart to apply* whenever they
differ. A drain/restart wizard can wait for guided onboarding.

**D5 — The minimal preflight (O5) is recommended for 1.0, not required.** If O1/O3
are fixed in `init` and the docs carry one correct path, a newcomer can succeed
without it. The cheap part is local checks only: Node version, git identity, code
repo HEAD, remote and base existence, `gh auth status`, and whether `claude`/`codex`
are on PATH. That would fit in `planestro check --preflight` and spends no quota.
Network, model-entitlement and CI checks stay post-1.0.

**D6 — Authentication: decided.** Planestro uses the `claude` and `codex` logins
already on the machine. Model API keys are dropped. It is a local developer
workstation tool, so access to the machine is the access control. There is no
Planestro login or access token, and none is planned. SECURITY.md has been
rewritten for this model (P3), and the key paths are removed (P9). Both are done
on this branch:

- `anthropic_api_key` is gone, along with its Settings row and the `secret`
  control. So are `accounts.api_key_env` (an account is now a `home`) and the
  `billing` / `api_key` state with its API-key wording.
- `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX`
  are dropped from every Claude session's environment, so a stray key or cloud
  switch can't bill anything but the login.
- An older `planestro.local.yml` loses its key, and any key-only account, at
  load, with one warning line each.
- The README, configuration, operations, concepts, troubleshooting and CLI docs
  say "your existing login".

Codex is unchanged. Its processes already get only an allowlisted environment,
and `OPENAI_API_KEY` reaches them only if a project lists it in
`codex_env_passthrough`.

`--host 0.0.0.0` and `lan_access` stay, documented as moving the boundary from
"this machine" to "every device on this network". SECURITY.md says to use them
only where every device is yours (Tailscale and similar).

### What the first audit missed

**A1 — Text from strangers reaches the agents once a managed repo is public.**
Traced through the code at this branch's head. Nothing marks outside text as
untrusted anywhere. The `[unverified]` items below are inferences about CLI/git
behaviour that need a test.

*Where outside text enters:*

| Source | Reaches | How much |
| --- | --- | --- |
| An imported issue's title and body (`issueImport.ts`) | Becomes the item's title and Description, created with actor `user`. The title is in **every** worker's system prompt (`worker-system.md`). The description goes to the planner, fresh briefs and every orchestrator packet (first 1,200 chars). | Whole body; only the trailing "Imported from <url>" line says where it came from. Comments and author are not imported. |
| PR comments and reviews (`pr_view`) | The orchestrator, on any wake, for **any** PR in `code_repo.github`, fork PRs and other people's included. `pr_diff` gives their diffs (100 KB). | Unfiltered. Every wake also lists up to 20 open-PR titles with author logins. No engine path gives PR comments to a worker; only the orchestrator can relay them, through `message_session` / `unblock_item` / `answer_question`. |
| CI failure logs (`runFailedLog`) | The worker's fix turn (`ci-failed.md`), and the orchestrator on a second red (3,000 chars) and through `run_view`. | ~160 lines. Read only for planestro's own PR heads (branch and SHA must match), so a fork PR's run is never picked. It still contains output of whatever ran, including base-branch tests others merged. |
| The managed repo itself | Both roles load its `CLAUDE.md` and `.claude/` settings (`settingSources: ['project']`). Workers read the worktree; the orchestrator can Read anything outside the secret list. | `[unverified]` A project allow rule or hook in `.claude/settings.json` would apply before planestro's `canUseTool`. |
| Worker MCP servers | Their results are outside text, auto-allowed up to the item's call cap. | Configured by the user, per model row. |

*What a manipulated orchestrator could do.* Most of its power is behind settings
that default off:

- **Approve a plan** only when `orchestrator.may_approve_plans` (default off)
  and the item's `auto_approve_plan` are both set.
- **Allow a worker's command** only with `orchestrator.may_decide_permissions`
  (default off). Nothing in code bounds what it allows then: `curl`, other `gh`
  commands and `WebFetch` all park rather than being hard-denied, so a delegated
  "allow" opens them. Codex grants stay limited to one exact command.
- **Two powers are not behind any setting.** Both are confirmed in code:
  - `submit_item` queues any non-epic item in any wake, an imported issue
    included. Only epics are restricted to the chat (#73). That spends on a
    planner reading the stranger's text, though the plan still waits for you by
    default.
  - **`unskip_merge` releases any hold, including one waiting on a person**
    (`orchestratorUnskips` never reads `hold_waits_on`). Your "Approve and hold
    the PR" and a `review.hold_into` hold can both be lifted, and green CI then
    merges. No test refuses it. This is a bug against the hold's own meaning, not
    just hardening.
- It steers workers (`message_session`, `answer_question`) and drives git
  through planestro (`sync_with_base`, `finish_from_worktree`,
  `resolve_epic_conflict`). It has no network of its own.

*What a manipulated Claude worker could do:*

- **Hard-denied:** `git push`, `gh pr`, `gh api …merge|pulls`, protected-branch
  operations, `git worktree`, branch deletion, `--force`, writes outside the
  worktree.
- **Parked rather than denied:** network (`curl`, `wget`, `WebFetch`).
- **Its Bash inherits planestro's environment**, minus the model-billing
  variables. That includes `GH_TOKEN` if planestro has it; Codex gets an
  allowlist instead.
- **Not on the secret list:** `~/.config/gh/hosts.yml`,
  `~/.claude/.credentials.json`, `/proc/self/environ`.
- **`[unverified]` Ways to run code without parking:**
  - `git rebase --exec` matches the fix turn's `git rebase*` allow;
  - `git fetch --upload-pack=` matches `git fetch*`;
  - `head -c … /proc/self/environ` matches the unscoped `head *`;
  - commit hooks the worker can edit.
- **Anything committed leaves the machine:** planestro pushes it, opens the PR,
  and merges on green unless held.

*The structural defences that hold:*

- Nothing is imported or queued from the board without you, except the
  `submit_item` gap above.
- Plans wait for you by default.
- Workers cannot push or merge.
- Destructive operations need positive evidence.
- Codex has no network and a clean environment.

*Proposed:*

- **P11 (bug, small):** the orchestrator cannot release a hold that waits on a
  person, and cannot `submit_item` an imported item outside the chat.
- **P12 (hardening):**
  - fence outside text in prompts (an "external content: data, not
    instructions" block around imported titles and bodies, `pr_view` comments
    and reviews, open-PR titles and CI logs), and say an item came from an issue;
  - add `gh`/`claude` credential files and `/proc/*/environ` to the secret list;
  - drop `GH_TOKEN`/`GITHUB_TOKEN` from Claude workers' environment;
  - test, and close, the `[unverified]` code-execution routes.

SECURITY.md's untrusted-input section (done) is the documentation half.

**A2 — CI covers Linux; the maintainer runs macOS.** *Decided: document it, no
macOS CI job.* The README's platform line, CONTRIBUTING and the release notes say
it: macOS is what the maintainer uses, Linux runs the test suite in CI, Windows
is untried. CI's `timeout-minutes: 10` is below the audit's local full-suite time
(13m48s with `--maxWorkers=2` on macOS). This branch's run took 5m14s on Linux
with default workers. Raise it to 20 before outside PRs run (P4).

**A3 — The Agent SDK is a root devDependency imported at runtime.**
`packages/server` imports `@anthropic-ai/claude-agent-sdk` (`LiveClaudePort.ts`,
`claudeBin.ts`), but only the root `devDependencies` declares it. `npm ci` from a
clone works because of hoisting. `npm ci --omit=dev`, or any later packaging,
breaks. Declare it in `packages/server` dependencies, together with the `engines`
field R8 already asks for. The SDK's own licence is not MIT. State in the README
that it is a third-party dependency under its own terms. Planestro does not
redistribute it.

**A4 — Nothing for contributors exists yet.** There is no CONTRIBUTING.md, no
issue or PR templates, and no Dependabot config. Beyond "expectations", 1.0 needs:

- a short CONTRIBUTING (issues welcome, PRs by prior discussion, `npm test`,
  `npm run typecheck`, the CLAUDE.md/AGENTS.md copy rule, and the invariants as
  the review bar);
- a bug template that asks for the platform, Node, provider CLI versions and the
  `blocked_reason`, and that warns against pasting planning data or secrets;
- `.github/dependabot.yml` for npm and Actions (this covers R6).

**A5 — Say what Planestro sends.** *Decided: a "what it sends" page, no
non-affiliation line.* A plain page that lists everything that leaves the
machine answers the privacy question better than a disclaimer, and says that a
build from source sends nothing. Planestro sends nothing at all, so the page is
short. Add `docs/what-planestro-sends.md`:

- there is no telemetry and no crash reporting;
- the only outbound traffic is git, `gh`, the provider CLIs, the MCP servers and
  notification command you configure, and other local planestro servers;
- your items, prompts and journal stay in your planning repo.

Link it from the README and SECURITY.md (P4).

**A6 — Working documents will be public.** *Decided: the Crystal Cavern dogfood
log is removed.* Crystal Cavern is a Hurricane Harrison level and doesn't belong
in this repository. `docs/notes/dogfood-crystal-cavern.md` is deleted, and the
one code comment and two test fixtures that named the level now use generic
names. Two things remain:

- **History still has the note.** It was added in `60d4fd2` (2026-10-07), and
  the owner's standing decision is not to rewrite history. If the level must not
  be public at all, history has to be rewritten before the flip. That is a
  decision for the owner, not engine work.
- **Code comments still cite its entries** as `dogfood pNN` (about 40, plus a
  few `HH-`/`LM-` item ids). These are bare references with no level content.

`docs/codex-epic-plan.md` stays, labelled as a historical working document.

**A7 — Releases since the audit add configuration surface the docs must cover
at 1.0:** accounts (#242, `planestro.local.yml` `accounts` with `api_key_env`),
`run_heavy` and runner shared labels (#218), `ci.infra_patterns` (#219), Undo last
turn (#234) and the Usage page (#236). None changes the security posture.
#242 deliberately keeps keys out of files, and is worth citing in SECURITY.md's
secrets section. Confirm that [Configuration](configuration.md) lists them
before release notes are written.

### v1.0.0 work (filed 2026-10-08)

These are the v1.0.0 issues, filed after the owner's review. Anything else here stays in this
document until after the release. Repository settings, the visibility change,
Pages and DNS, the privacy read and the live acceptance runs are the maintainer's
own steps, not engine work. They stay as checklists below and are not issues.

| # | Proposed issue | Covers | Size | Status |
| --- | --- | --- | --- | --- |
| P1 | `init` creates and verifies a planning git repo, resolves the base or refuses to guess, and validates before writing | O1, O3 (base fallback, linked-worktree `ENOTDIR` via `git rev-parse --git-path`), D3 (withdraw `orphan-branch`) | M | Done (#332) |
| P2 | One correct install path across README, Getting started and the site quick start | O1/O2/O4 docs, loopback-only examples, D6 "existing login" wording on the site, platform/Node statement, Codex-only recipe linked from the main path | M (docs) | Filed #333 |
| P4 | Public-repo hygiene | A2 (document platforms, CI timeout 20), A3 (SDK dependency, `engines`), A4 (CONTRIBUTING, templates, Dependabot), A5 (`what-planestro-sends.md`) | M | Filed #334 |
| P5 | Show running vs saved engine mode | D4 indicator | S | Filed #335 |
| P6 | Bound multipart uploads before buffering | Body/file-count limits on both upload routes; bounded audition/media reads | S | Filed #336 |
| P7 | Setup check: `planestro check --preflight` | D5: Node, git identity/HEAD, code repo remote and base, `gh auth status`, `claude`/`codex` on PATH and signed in (without a model call), port, planning git; one repair per failure | M | Filed #337 |
| P10 | Site redesign for v1.0.0 | M1–M7: product demonstration, one primary CTA, audience/prerequisites/cost, current screenshots, FAQ, repo/licence/support links, "coming soon / private" copy updated at the flip | L | Filed #338 |
| P11 | The orchestrator cannot release a person's hold or queue an imported item outside the chat | A1: `unskip_merge` vs `hold_waits_on: person`; `submit_item` vs `source.github_issue` | S | Filed #339 |
| P12 | Treat outside text as data | A1: fence imported issues, PR comments/reviews/titles and CI logs in prompts; secret list (`gh`, `claude` credentials, `/proc/*/environ`); drop `GH_TOKEN` from Claude workers; test the unverified code-execution routes | M | Filed #340 |
| P3 | SECURITY.md and trust-model refresh | | | Done on this branch |
| P9 | Remove the model API-key paths | | | Done on this branch |
| P8 | Release v1.0.0 | Version bump, release notes, tag | | Checklist, not an issue |

Deferred until after 1.0 and not proposed as issues yet: guided onboarding and
welcome screen, new-item simplification and sample tour (O6), user study,
network-preflight and model entitlement checks, bundle splitting, packaging,
Windows.

## What was verified

| Check | Result and limits |
| --- | --- |
| Clean-worktree installation | `npm ci` succeeded on macOS with Node **24.11.1**, using the committed lockfile. Existing machine tooling/caches were available; this is not a clean-machine certification. |
| Type checking | `npm run typecheck` passed on `05be427`. |
| Production build | `npm run build` passed on `05be427`. Largest JS chunk: **1,001.04 kB / 312.83 kB gzip**, plus a **162.53 kB / 53.99 kB gzip** common chunk. Bundle-size and Zod annotation warnings remain. |
| Exact-revision GitHub CI | The `check` job passed on `05be427`: [run evidence](https://github.com/gravesisme/planestro/actions/runs/37802619497/job/113398498943). The workflow runs install, typecheck, the full test suite and build on Node 24/Linux. |
| Local test validation | **1,018 tests passed across 117 files** on `05be427`, using `npm test -- --maxWorkers=2 --reporter=verbose` (13m 48s). The earlier unrestricted run was stopped when advancing the audit snapshot; the final full run completed with no failures. |
| Dependency advisories | Fresh `npm audit --json`: **zero known vulnerabilities**, including development dependencies. This supersedes the five affected packages listed on October 3. |
| Secret scan | Fresh GitHub mirror; **Gitleaks 8.30.1**, official archive checksum verified, default rules, `git --log-opts=--all --redact`: **zero findings**. Mirror: **33 branches, 187 PR refs, no tags**, **563 reachable commits**; scanner reported **526 commits / 8.30 MB scanned**. Includes `05be427`. |
| Sample | CLI seeded **14 items** in a disposable directory. The sample regression passed, including a simple item through FINISHED and a mixed-agent epic with art review. Local browser inspection covered the board, new-item form, and marketing homepage/quick start; no live model calls. |
| Initialization probes | Disposable repos reproduced missing planning Git history, wrong fallback base, an ineffective orphan-layout option, and failure when nesting planning inside a linked worktree. Details below. |
| Mode-change probe | In the disposable server, saving `engine.mode: live` returned saved config `live` while `/api/engine` remained `dry-run`. Restored config to `dry-run`; no live engine was started. |
| GitHub release controls | Still **private**; `main` reports **`protected: false`**. Ruleset API returns the private-plan restriction (403). Actions default token is read-only and cannot approve PRs. Vulnerability reporting and Pages API return 404; enablement remains unverified. No `PAGES_ENABLED` variable was listed. |

The source review sampled request/file boundaries, initialization, settings,
planning Git safety, merge/deletion safeguards, provider permissions, operator
MCP, schedules, recovery-related changes, and the onboarding UI/docs. It was
not a line-by-line audit of all changed code, a penetration test, or a paid
live-agent/platform certification. A clean advisory or secret scan is not proof
that no vulnerabilities or private information exist. PR descriptions/comments,
uploaded media and Actions artifacts are outside the Git text scan.

## Previous release checklist: current disposition

The R identifiers are retained so earlier discussions still have a reference.
Checked entries below mean the stated work/evidence is present; they do not mean
an entire public release has been approved.

| ID | Current disposition | Remaining work |
| --- | --- | --- |
| R1 — active attachments | **Implemented and merged.** Managed SVG/HTML/PDF download, with sandbox CSP and `nosniff`. | Keep coverage as new preview routes are added. |
| R2 — attachment containment | **Implemented and merged.** Shared helper validates item/file names, real paths and symlinks for managed attachments, including new chat attachments. | Audition files use a separate allowlist/realpath check; retain separate regression coverage. |
| R3 — private planning settings | **Implemented and merged.** Required ignores are repaired; tracked private paths stop unsafe Git operations; outgoing history is checked; local config writes use private permissions. | New-user setup still needs to establish a Git repository in the first place (O1). |
| R4 — verified merge head | **Implemented and merged.** Merge requires the verified SHA via `--match-head-commit`. | Keep the moved-head regressions. |
| R5 — conditional deletion | **Implemented and merged.** Conditional remote/local ref deletion; no merge-time `--delete-branch` shortcut. | Keep fresh-fetch, merged-PR, ancestry and dirty-tree checks. |
| R6 — dependencies | **Patch work complete:** current audit has zero findings; Vitest is now 4.1.11. | Add recurring dependency updates and a documented advisory-handling check. No Dependabot/Renovate configuration or dependency-audit CI step is present in the reviewed tree. |
| R7 — publication privacy | **Fresh all-ref scan complete.** Prior owner acceptance of personal commit email, historical home paths, Hurricane Harrison references and retained history still stands. | Review new public-facing PR/issue material, screenshots and Actions output added since the owner's October 3 review; scan again if more code/refs land before publication. |
| R8 — installation/docs | **Still incomplete; materially more important now.** The website correctly initializes a separate planning Git repo, but the README/manual do not. | Fix O1–O5 and the supported-provider/startup instructions. Add Node engines metadata and concise contribution/support expectations. |
| R9 — GitHub controls | **Partly complete.** Read-only Actions token, MIT license, security policy, topics and description exist; wiki/discussions are off. | Required CI/force-push/deletion controls, private vulnerability reporting, available secret scanning/push protection/dependency alerts, and fork-workflow verification. |
| R10 — release checkpoint | **Open.** Current CI and scans are encouraging, not a release authorization. | Release notes, supported-path acceptance, explicit visibility decision and post-publication anonymous checks. Resolve version messaging. |

Evidence: [attachment routes](../packages/server/src/routes/api.ts),
[managed paths](../packages/server/src/store/managedAttachments.ts),
[planning Git safety](../packages/server/src/store/planningGitSafety.ts),
[Git committer](../packages/server/src/store/GitCommitter.ts),
[live Git/GitHub ports](../packages/server/src/engine/live-ports.ts),
[CI workflow](../.github/workflows/ci.yml).

Other improvements since the previous audit deserve credit: persisted pending
instructions and lost reports; bidirectional provider recovery and Codex
orchestration; secret-path denials and an allowlisted Codex environment;
machine-wide permission rules with deny precedence; runner-stall handling;
once-per-wait notifications; MCP import/settings; schedules; file diffs;
mobile recovery and action feedback; an all-projects overview. PR #315 also
puts an active item's current state, phase and appropriate action at the top
of its quick view. Extend that progress to onboarding rather than rebuilding it.

## Onboarding findings

### O1 — The shortest real-project recipe does not establish its promised history

**Priority: fix the documented path before inviting live use. Reproduced.**

[README](../README.md#using-it-on-your-own-project) and
[Getting started](getting-started.md#your-own-project) call `init` on a new
sibling directory without `git init`. [initDataDir](../packages/server/src/init.ts)
creates the files but never initializes Git; [GitCommitter.enabled](../packages/server/src/store/GitCommitter.ts)
is false without a `.git` entry. The probe left a valid-looking planning folder
with **no Git history**, despite the product's versioned-history promise.
The [website quick start](../site/quick-start/index.html) already includes the
missing `git init`; this is drift between entry points, not a universal failure.

**Recommendation:** immediately make all supported recipes create a separate
local planning Git repository and confirm its first commit. Explain that backup
is a separate step and that any remote should be private. Longer term, setup
should offer to create this repository itself, show its location, check the Git
identity, and report whether history and backup actually exist. Do not silently
fall back to unversioned storage while presenting a successful setup.

**Done when:** following the shortest advertised recipe in empty sibling folders
produces a planning commit; a subsequent item edit makes a semantic commit;
missing Git identity has a clear repair; no planning files enter the code repo.

### O2 — "Switch to live" omits the required restart

**Priority: fix before inviting live use. Reproduced.**

Both short guides tell the user to change `engine.mode`, then start real work.
The [settings registry](../packages/shared/src/settings.ts) does label this as
restart-required, but the [server](../packages/server/src/server.ts) constructs
ports once and [LiveEngine](../packages/server/src/engine/LiveEngine.ts) keeps
that mode. The live-mode save probe left the actual engine in dry-run. A user
can believe their first task is being implemented while it is still simulated.
The local mode override is another source of confusion.

**Recommendation:** document stopping/restarting the foreground server and
checking the running **Live** indicator, not just the saved setting. Put a
persistent "restart required; still simulating" message beside a changed mode.
For guided setup, provide an explicit enable-live step that explains the
pending actions, drains/restarts safely, and verifies the effective mode.
Do not convert an in-progress simulated item into real work.

**Done when:** a user can distinguish configured, overridden and running mode;
a new live task cannot look like real work while the engine is still simulated;
the guide completes without discovering the restart requirement elsewhere.

### O3 — Initialization trusts assumptions that it should check

**Priority: repair or document supported workarounds before source release;
fix in guided setup before broad launch. Reproduced in disposable repositories.**

| Trigger | Observed result | Needed behavior |
| --- | --- | --- |
| Repo on `trunk`, without `origin/HEAD`, no explicit branch flag | Generated `default_branch: main` | Resolve/verify the intended remote branch, or ask; never guess silently. For now, explicitly pass and verify `--default-branch`. |
| `--layout orphan-branch` | Files created, but no planning `.git`, orphan branch or second worktree | Implement the advertised layout, or withdraw/document the flag as requiring a pre-created worktree. Recommend the separate planning repo to newcomers. |
| Planning nested inside an existing linked code worktree | `ENOTDIR` opening `.git/info/exclude`, after some files had already been written | Resolve Git metadata through Git, validate before writing, and make failure/retry leave a clear state. For now, use a separate sibling planning repo. |

`init` checks for `.git` existence, not a complete live-ready repository.
[`check`](../packages/server/src/cli.ts) validates stored files and reports
access configuration; it is not a preflight for agent authentication, GitHub
permissions, remote/base existence, dependency preparation or base CI.
Calling it a readiness check would overstate what it does.

### O4 — Provider choice is supported by the engine but not by one coherent setup path

**Priority: correct claims before source release; simplify before promotion.**

The engine now supports Claude-only, Codex-only (app-server), and mixed projects.
The README requirements/manual still say Claude is required; the homepage still
says Codex implementation is optional and labels the planning step "CLAUDE + YOU".
The website guide acknowledges either provider, then gives Claude-specific
commands and model checks. `init.ts` even retains the obsolete comment that a
Codex CLI model never plans. The accurate Codex-only recipe is in
[Switching providers](switching-providers.md#codex-only-setup), a separate document.

The README's authentication section directs readers toward a Console API key,
while the site teaches local sign-in and Settings describes the key as optional.
Resolve these statements against current provider guidance before publishing
billing/authentication claims; this audit does not determine vendor terms.
Explain what Planestro technically uses, who bills usage, and what is optional.

**Recommendation:** select **Claude** or **Codex** once during setup; detect
installed tools without spending model quota; set planner, implementer and
orchestrator consistently. Keep transport IDs, fallback chains, art routing and
mixed-provider tuning under Advanced. Prefer the existing Codex-only switching
logic where appropriate. Check model availability explicitly before promising
success; baked-in model names are not an entitlement check.

**Done when:** separate Claude-only and Codex-only first-task scripts work without
the other CLI installed. Documentation also explains Planestro's dedicated Codex
login home and its recovery path, without sending users to unrelated settings.

### O5 — A successful install still leaves substantial operational setup to the user

**Priority: the main usability work before broad promotion. Source inspection.**

The guide asks the user to arrange Node, Git identity, GitHub authentication, an
agent login, a committed repository, a pushable remote, base/PR CI, a second
planning repository, model choices, budgets, dry-run and live mode. These are
legitimate requirements for automated merges, but "four steps to the board"
conceals the number of decisions. Reaching the board is not reaching value.

Fresh worktrees also need project dependencies. The generated config has an
empty `hooks.after_worktree_create`; Claude permission allows start empty beyond
built-ins, and Codex's default command sandbox has no network. The starter
project happens to need no install. A real project can stop on its first test
or package install unless setup prepares it. A fake dry run cannot validate
credentials, worktree installation or CI access.

**Recommendation:** add a read-only preflight with actionable pass/fail results:
Node version, Git identity/HEAD, repository/remote/base, selected provider login,
model configuration, GitHub access, base and PR CI expectations, available port,
planning Git/backup status, and an explicitly reviewed worktree setup command.
Separate checks needing network from local checks. Never silently run repository
hooks, approve broad permissions, create a GitHub repository, or start a paid
turn as a "connection test". A guided preflight should persist its result and
leave no held agent process while the user fixes something.

**Done when:** missing prerequisites are found before queueing the first task,
each failure offers one concrete repair, and a dependency-bearing project can
run its first tests in the worker's actual environment.

### O6 — The first task exposes the expert operating model too early

**Priority: adoption improvement, not a security or source-publication blocker.**

The initial board exposes nine main navigation destinations, lifecycle columns,
category/priority filters, provider switching and the orchestrator. The new-item
form offers prompt template, item/epic, category, priority, model, optional parent,
fallback choice, title and description. Settings has nine sections and 94
registered entries. These are useful controls, but they are not a beginner's
checklist. This was visible in the disposable sample and is supported by
[NewItemDialog](../packages/web/src/components/NewItemDialog.tsx),
[Settings](../packages/web/src/pages/Settings.tsx) and
[the settings registry](../packages/shared/src/settings.ts).

**Recommendation:** start with a title and description, a visible inherited
provider, and a clear **Create and plan** action whose label explicitly authorizes
submission. Keep **Save to backlog** available. Put category, priority, epic,
routing and fallback behind optional details. Show the next meaningful action
and a compact progress explanation, building on PR #315. Keep current technical
statuses for diagnostics and persisted state; simplify presentation without
changing lifecycle semantics. Retain visible pause, budget and review controls.

The sample is valuable, but 14 examples, mixed art/code, epics, releases and
questions make it a showcase as well as a tutorial. Lead with one highlighted
bug and a three-action tour; reveal the rest after the first completion.

## Recommended onboarding design

These are proposed product changes, not commands/features that exist today.

1. **Explore:** the first CTA opens a short product walkthrough or the isolated
   sample. No GitHub or agent login is needed to see a task reach simulated Done.
   Keep simulation explicit. A hosted interactive demo is a later option, not
   something to claim is already available.
2. **Connect:** select an existing repository. Infer name/prefix and suggest a
   separate local planning Git repository; show/confirm the detected base and
   selected provider. New-repository creation stays an optional separate recipe.
3. **Check:** run preflight and present only failures needing attention. Confirm
   any dependency setup and a conservative first-run profile: one worker, human
   plan approval, finite usage limits, and the first PR held for human review.
   Persist choices; advanced automation comes later.
4. **Ship one small change:** type the task, deliberately enable live execution,
   approve the plan, inspect the tested PR and release its hold. Explain what
   happens next and how to stop. Keep the trial's real/simulated identity clear.
5. **Expand when useful:** epics, mixed agents, schedules, MCP tools, policy
   suggestions, notifications, release notes and more concurrency.

For the first iteration, a guided CLI plus a small welcome/preflight screen is
sufficient. Do not make a packaged desktop app a dependency of this work. If a
single launcher is later introduced, it should validate Node, install/build the
pinned version, select a free local port and open the UI; it should not silently
modify shell configuration or widen network/agent permissions.

Measure this with **five developers unfamiliar with Planestro**, covering
Claude-only and Codex-only paths and one project that needs dependency setup.
Proposed acceptance targets, not measured results:

- At least four of five complete the sample without assistance in five minutes
  **after installation**; measure install time separately.
- At least four of five reach their first real plan within fifteen minutes
  **after required tools/accounts are ready**, without editing YAML or asking the
  maintainer. Report wall time and prerequisite time separately.
- Every participant can identify demo vs live mode, pause work, find the pending
  decision, and explain whether the first PR will merge automatically.
- Record failed steps, unnecessary choices and permission interruptions. Measure
  time to first tested PR separately from CI/model latency; do not market a
  "one minute" experience until an unassisted first-time run supports it.

## Marketing site: compete on demonstrated outcomes and ease of entry

The current site already has coherent typography, restrained styling, product
captures, copy buttons, a substantive field note and a useful static deployment
model. It does not need a new framework. The bigger problem is that its primary
CTA opens installation documentation, the sample is secondary, and the hero
explains a workflow before showing the product doing useful work.

### Market benchmark

Reviewed a comparable agent development tool’s public homepage in the browser
on October 8.
Its presentation makes download, supported agents and a no-account entry point
prominent, with interactive product previews for parallel work, approvals,
backlog handling and editing. It also presents settings import and reusable
flows. Those are website observations, not an installed-product evaluation or
a reliability comparison. The live page was newer than the search cache; this
audit does not use cached release/platform claims as current fact.

The useful benchmark is the ease of understanding the first action and seeing
its result. Planestro should show how a requirement reaches an approved plan,
a tested PR and a controlled merge, with decisions recoverable after a restart.
Parallel agents and backlog handling alone are not a distinctive pitch.
Do not claim other products lack Planestro's safeguards without inspecting their code and
behavior; the recommendation is to prove Planestro's strengths directly.

### Proposed site work, in order

| Order | Recommendation | Acceptance criterion |
| --- | --- | --- |
| M1 | Put a current, sanitized product demonstration beside the hero: requirement → plan approval → work → CI → held PR/merge. Use a short captioned recording or lightweight interactive walkthrough. | A newcomer can identify what they will do and what Planestro handles within a short visit. Include pause/reduced-motion behavior and a static fallback. |
| M2 | Use one primary CTA appropriate to availability: **Try the demo** when a demo exists, or **Run the sample** with honest install requirements; **Use my repository** is secondary. Keep the article as supporting evidence. | No dead end at a private repository, no implied instant browser demo when only source installation exists. |
| M3 | State the audience and prerequisites close to the CTA: solo developers with a GitHub repo and CI; Claude or Codex; local app, no Planestro account; agent usage billed by its provider; tested platform scope. | A visitor can judge fit, cost and setup before reading a long guide. |
| M4 | Replace the abstract-only workflow panel with the actual first-task UI and three proof points: controlled integration, durable decisions, and human review/pause. | Each claim links to a visible example or concise documentation, with no absolute promise that CI catches every bug. |
| M5 | Refresh screenshots to the current product, including current-state drawers, diffs, provider recovery and phone decisions. | Current screenshots are captioned as current; historical blog screenshots keep their dates and context. No private backlog text or credentials appear. |
| M6 | Make README, quick start and product welcome follow the same demo/live routes and provider terminology. | Each advertised recipe is executed from a clean checkout on the tagged revision; code blocks are checked for drift. |
| M7 | Add a short FAQ and visible source, license, support and release-status links. | Answer "Why not just my agent CLI?", "What does this cost?", "Can it push/merge?", "Can I pause?", "Where are my files?", "What if it stops?" and "Which platforms work?" without a deep manual search. |

Suggested positioning to test: **"From backlog to tested merge. You approve the
decisions."** Supporting copy should explain that Claude or Codex does the
work while Planestro coordinates branches, PRs, CI and recoverable decisions.
Avoid the unlimited-provider implication of "Any agent" unless the supported
adapter contract warrants it. "Claude or Codex" is concrete and already useful.

Lead with one real workflow and one case-study result whose evidence is dated
and attributable. Keep the Hurricane Harrison article as proof of sustained
use; do not make understanding a game's release schedule a prerequisite to
understanding Planestro's availability. A visual flow builder, built-in editor,
large integrations catalog or another chat shell is not the first competitive
investment: a reliable, short path to a reviewed change is.

## Security and operational qualifications for launch

- **Keep the advertised launch path on loopback.** README background examples
  still use `--host 0.0.0.0 --watch`. Replace those routine examples before
  inviting newcomers. `lan_access` now filters socket peer addresses, but it
  does not authenticate a person; an allowed private address or a local proxy
  is not proof of trust. Explicit `--host` binding and `lan_access` filtering
  are separate controls. Do not promise that all forwarding/proxy setups are
  blocked. No account system is required for a local-only first release.
- **Reconcile the network roadmap.** *Resolved (second review, D6):* no access
  token is planned. Machine access is the access control, and LAN/phone use is
  documented as extending it to a network where every device is yours.
- **Document provider permission boundaries accurately.** Claude policies are
  guardrails, not OS isolation. Codex has separate exec/app-server capabilities;
  app-server can park a native command approval and use an exact one-time grant.
  Broad statements that "Codex cannot ask" are now stale. Configured MCP services
  and reviewed setup hooks also need their own trust explanation.
- **Bound requests before buffering.** Both item and new orchestrator-chat upload
  routes parse multipart data and materialize buffers before store-level limits.
  Add total-body/file-count limits and bounded audition/media reads. This remains
  hardening for the local trusted-operator release, and becomes more urgent if
  network exposure is promoted. No new exploit was demonstrated by this audit.
- **Backups and upgrades must be explicit.** A local Git history is not an
  off-machine backup. Document an independent backup/private remote, migration
  steps, and restoring both data and a compatible tool version. Current schema
  is **7**; warn against opening upgraded data with an older checkout. Keep
  consumer startup separate from `--watch` development/update behavior.
- **Keep supply-chain checks routine.** Add dependency-update PRs, an advisory
  check with an exception policy, and secret scanning. Keep Actions permissions
  explicit and consider pinning actions by commit. Public-fork jobs must not get
  privileged persistent runners or secrets. Current CI uses `ubuntu-latest`
  and `pull_request`, not `pull_request_target`.

## Publication gate

Complete this short gate before changing visibility. The complete onboarding
redesign and site redesign can follow a clearly labeled experimental release.

- [x] Merge R1–R5's security/data-loss fixes; confirm the safeguards remain in the
  current source. They are already merged, not waiting in the old review worktree.
- [x] Resolve the previous dependency advisory inventory; fresh audit is clean.
- [x] Repeat the redacted all-ref scan, including current PR refs (`05be427` mirror).
- [ ] Review **new** issue/PR prose, uploaded media and Actions logs/artifacts since
  October 3. Retain the prior owner decisions about historical identity/paths;
  do not rewrite history just because old branches exist. Keep planning data
  and pre-rewrite backups out of the public code repository.
- [x] Publish one correct experimental installation path: separate planning Git
  repo, explicit verified base, correct provider instructions, loopback startup,
  and mode-change restart. Document O3 workarounds until implemented.
  *(Pre-open-source audit, 2026-10-17: `init` creates and commits the planning repository,
  resolves the base without a literal fallback, and excludes a nested folder through git;
  README and Getting started give the restart and loopback recipe, and document
  `--layout orphan-branch` as needing its worktree first. #332, 2026-10-18: `--layout` is withdrawn
  (D3); a planning worktree nested in the code repo is documented and committed on its branch.)*
- [x] State support/contribution expectations and supported Node/platform versions;
  declare Node compatibility in package metadata. *(CONTRIBUTING.md, `engines`, `.nvmrc`, 2026-10-17.)* Clone/install/build is an
  acceptable first distribution; the private workspace package flags do not
  themselves block making GitHub source public.
- [ ] Prepare required `check` status, force-push/deletion restrictions and security
  reporting/scanning settings. If plan restrictions prevent setup while private,
  apply and verify them at the visibility change before inviting contributions.
  Confirm the vulnerability-reporting link in SECURITY.md actually works.
- [ ] Pick coherent release/version language. Package metadata says **0.1.0**;
  the site announces **v1.0.0** alongside Hurricane Harrison **v1.6.0**. Do not
  silently undo that announced plan, but decide whether an experimental source
  opening precedes it and explain the distinction consistently. *(Second review,
  D1: the opening is v1.0.0, with a written support contract.)*
- [x] Rewrite SECURITY.md for the machine-access trust model, including untrusted
  input (A1). *(Second review, D6/P3.)*
- [x] Remove the model API-key paths from code and docs (D6, P9).
- [x] Document the platforms (macOS used, Linux in CI) and raise CI's timeout to 20 minutes.
  Declare the Agent SDK as a `packages/server` dependency (A2, A3). *(2026-10-17.)*
- [x] Add CONTRIBUTING, issue/PR templates, Dependabot and `docs/what-planestro-sends.md`
  (A4, A5). *(2026-10-17.)*
- [x] Remove the Crystal Cavern dogfood log (A6). Decide whether history must be
  rewritten for it before the flip.
- [ ] Record the release revision, CI, audit and scan evidence, accepted exceptions,
  installation/update/backup instructions and known limitations in release notes.
  Refresh checks on the actual release commit if it differs from this one.
- [ ] Change repository visibility only on an explicit user instruction. Verify
  anonymous clone, README links/images, sample install, required CI and private
  reporting afterward. Repository publication must not expose a runtime port
  or planning repository.

## Additional gate before recommending live use broadly

- [ ] Fresh-user Claude-only trial: small task → plan → approval → implementation
  → held PR → CI → reviewed merge → cleanup.
- [ ] Repeat for Codex app-server-only, with no Claude installation required.
- [ ] Exercise one dependency-bearing project and a non-default-named base branch.
- [ ] Pause and restart between steps; answer a persisted question/permission after
  restart; confirm the instruction and selected provider survive.
- [ ] Demonstrate a CI failure/recovery and a refusal to clean up unexpected local
  work. Record CLI/SDK versions and which paths were live versus simulated.
- [ ] Repeat the install/sample/first-task recipe on the release revision with a
  new user. Run additional platforms before expanding support claims.

Current compatibility declarations, not newly executed live certifications:
Claude Code **2.1.284**, Agent SDK **0.3.251** (validated September 28);
Codex CLI **0.154.0** (validated October 7), from
[compat.ts](../packages/server/src/compat.ts). This audit spent no model quota
and created no GitHub test repositories or PRs.

## Marketing-site publication is a separate operation

The site remains a static `site/` artifact, deployed as-is by the existing Pages
workflow. Retain that simple architecture unless a specific product requirement
justifies changing it.

- [x] Existing homepage, quick start, blog and approved field note are present.
- [ ] Configure Pages for Actions and deliberately set `PAGES_ENABLED=true`.
  Current API access returned 404 and the variable was absent.
- [ ] Configure/verify `planestro.com`, DNS and HTTPS; no `site/CNAME` is present.
  DNS and registrar state were not inspected in this audit.
- [ ] Test all four routes, direct article anchors, share images and mobile layout
  at the domain root. Root-relative assets do not fit an unconfigured
  `/planestro/` project subpath.
- [ ] Change private-access/coming-soon notices only when access actually changes.
  Preserve the article's approved historical copy and review its release notice
  deliberately rather than rewriting the case study wholesale.

## Suggested execution order

1. **Correct the entry path:** O1–O4 documentation, supported-platform/auth wording,
   restart instructions, loopback examples and release-version decision.
2. **Open the source deliberately:** privacy review of new material, GitHub controls,
   experimental release notes, exact-revision checks and anonymous verification.
3. **Make first use reliable:** O3 initialization fixes, preflight, one-provider
   setup, worktree preparation and a first PR held for review; run the live matrix.
4. **Make first value obvious:** simplify new-task controls and the sample tour;
   measure unassisted users; publish a current product demonstration and clear CTAs.
5. **Optimize after evidence:** bundle splitting, packaging convenience, additional
   platforms and deeper integrations. These are useful, but they should not delay
   correcting the setup path or replace the first-use work.
