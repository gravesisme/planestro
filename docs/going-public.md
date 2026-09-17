# Going public — checklist

What stands between this repository and flipping it to public, written so a
later session can pick it up cold. Delete this file when the repo is public and
the list is empty; it is a working document, not documentation.

**State on 2026-09-17:** private repo, ~35 commits, ~7k lines of TypeScript,
one author. The `public-prep` PR did the first pass below.

## Done in the first pass

- [x] `LICENSE` (MIT) and `"license"` in `package.json`.
- [x] Project-neutral naming: `withGodotLock` → a real `max_local_jobs`
      semaphore (the old setting was never read: the lock was a plain mutex),
      `concurrency.max_godot_jobs` → `max_local_jobs` with a schema-2
      migration, the unused `godot_bin` local key removed, default categories
      no longer a game studio's.
- [x] The one-off importer moved to `packages/server/src/import/legacy/` with a
      header saying what it is and that only its shape is worth copying.
- [x] Home-directory paths scrubbed from `docs/sdk-notes.md` and the spike
      (which now requires `SPIKE_CWD` instead of defaulting to one).
- [x] `planestro sample` / `npm run sample`: a seeded fictional project that
      runs the whole lifecycle in dry-run with no repo, remote or login; the
      dry-run world is rebuilt from the items on restart; `sample.test.ts`
      keeps it working.
- [x] README rewritten for someone who has never seen the tool, led by the
      one-minute demo, with two screenshots taken from the sample.
- [x] GitHub Actions CI (typecheck, tests, build) on PRs and `main`.

## Decisions only the author can make

- [ ] **MIT or something else.** MIT was chosen as the unsurprising default.
      Apache-2.0 adds a patent grant; AGPL would stop a hosted clone. Change
      `LICENSE` + `package.json` before the flip, not after.
- [ ] **Name the game or not.** The README says "a commercial game that ships
      on the App Store" and stops there, because the game's own public copy
      deliberately never mentions AI tooling. Linking the two is the stronger
      portfolio story and cannot be undone once indexed.
- [ ] **Commit email.** Every commit carries a personal Gmail address. Fine for
      most people; if not, it needs a history rewrite (see below) and a
      GitHub `noreply` address going forward.
- [ ] **The name.** Check `planestro` on npm, GitHub and as a trademark before
      it is attached to a public identity. (`package.json` stays
      `"private": true` either way until publishing to npm is a decision.)
- [ ] **Keep or rewrite history.** See the audit below; a squash to one
      "initial public commit" is the cheap way out and loses nothing an
      interviewer would read.

## History audit (do this before the flip — it is the irreversible part)

Making the repo public publishes every commit, not just `main`'s tip.

- [ ] `git log --all -p | grep -nE "sk-ant-|ghp_|github_pat_|BEGIN (RSA|OPENSSH)"`
      — a `sk-ant-` search was clean on 2026-09-17; re-run all of them, and
      run `gitleaks detect` or `trufflehog git file://.` once for a real scan.
- [ ] Old commits still contain what the first pass removed from the tip: the
      `/Users/<name>/Projects/<game>` paths (spike, sdk-notes), the legacy
      importer at its old path, and ~7 commit messages that name the game or
      its item ids (`HH-9`, `HH-94`…). Nothing secret — decide whether it
      matters (see "Name the game or not").
- [ ] `git branch -a` and `git tag`: delete stale remote branches before the
      flip; they become public too.
- [ ] Confirm the *data* never lived here: the planning data dir is an orphan
      branch of the game's repo, not of this one. `git log --all --stat -- items prompts journal` should be empty apart from
      `packages/server/prompts/` (the shipped defaults).
- [ ] Read the shipped default prompts (`packages/server/prompts/*.md`) once as
      a stranger would: they are the most-read "source" in the repo.

## Repository hygiene

- [ ] `CONTRIBUTING.md` — or a plain sentence in the README that this is a
      personal tool and PRs may sit. Setting expectations beats a template.
- [ ] `SECURITY.md`: how to report, and the threat model in one paragraph (no
      auth on the web UI by design, binds to loopback, agents run with the
      user's own git/gh credentials, the permission policy is a guard rail and
      not a sandbox).
- [ ] Issue templates are optional; turning **off** the wiki/projects/
      discussions tabs you will not tend is not.
- [ ] Branch protection on `main` requiring the CI check, once CI has been
      seen green on Linux (it has only ever run on macOS locally — expect a
      path or default-branch assumption to surface on the first run).
- [ ] Repo description, topics (`claude-code`, `agents`, `orchestration`,
      `kanban`, `local-first`), social preview image (the mark on the dark
      tile, 1280×640).
- [ ] Dependabot or Renovate for the npm workspace; `npm audit` clean at flip.
- [ ] `CHANGELOG.md` + a `v0.1.0` tag at the flip so "what changed" has an
      anchor. `TOOL_VERSION` already exists.

## Product gaps a stranger will hit first

- [ ] **Install story.** Today it is clone + `npm install` + `npm run build` +
      `npx tsx …`. A `bin` entry and `npm link`/`npx planestro` would halve the
      README's quick start.
- [ ] **Platform.** `open`, `say "PR merged"` and recursive `fs.watch` are
      macOS-shaped. `openWhenUp` already branches per platform; `--watch`
      needs Node ≥ 20 on Linux for recursive watch; say so or test it.
- [ ] **Web UI has no auth.** Documented loudly; an optional shared-secret
      token for `--host 0.0.0.0` would turn a warning into a feature.
- [ ] **Model ids are hardcoded in the init template** (`claude-fable-5`,
      `claude-opus-5`). They age; `init` could ask `claude` what exists, or the
      README should say where to edit them.
- [ ] **The dry-run agent's plan is a stub** ("1. Inspect the code…"). For the
      demo, a handful of canned, item-aware plans — or a recorded real session
      replayed — would make the sample far more convincing.
- [ ] **Bundle size**: one 700 kB chunk. Harmless locally, but it is the first
      thing a front-end interviewer's eye lands on in the build output.
- [ ] **Accessibility / keyboard**: board drag has no keyboard path (dnd-kit
      supports one); confirm/prompt dialogs are `window.confirm`/`prompt`.
- [ ] A worker that finds the work already done during *planning* still loops
      on `no_plan` (its `report_done` is ignored in that phase); only the
      user's **close as done** ends it. Let the planner report it, and let the
      orchestrator propose the close.
- [ ] One project per server process; the registry in `~/.planestro` hints at
      more. Either finish it or stop mentioning it.

## Portfolio / interview material

- [ ] A two-minute screen recording of the sample: queue → plan → approve →
      PR → CI red → fixed → merged → done (`PLANESTRO_DRYRUN_CI=red-once`
      gives the red run). Link it at the top of the README.
- [ ] A second, real recording: one actual item on the real project, sped up,
      showing a parked question and a resume after restart — the part that is
      hard and that the fake cannot show.
- [ ] `docs/architecture.md`: the four ports, the state machine table, the
      reconciler, the park/resume protocol, with one diagram. `CLAUDE.md` has
      the rules; nothing yet has the picture.
- [ ] A short write-up of three war stories already in the git log — the stale
      base-red gate, the double-counted CI run, budget caps that surfaced as
      `no_plan` — each is a "tell me about a bug" answer with a commit to show.
- [ ] Numbers from real use: items shipped, PRs merged, median queue-to-merge
      time, spend per item. The journal and item files already hold all of it;
      a `planestro stats` command would make the README's claim checkable.

## The flip itself

1. Land everything above that is marked a blocker for you.
2. Re-run the history audit on the exact commit range being published.
3. If rewriting: fresh repo or `git checkout --orphan`, one commit, force-push
   while still private; re-clone every worktree.
4. Settings → change visibility. Then: check the README renders (images,
   badge), the Actions tab runs, and clone it logged-out.
5. Run `npm run sample` from that fresh clone on a machine that has never seen
   the project. That is the interviewer's experience.
