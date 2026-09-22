# Going public — checklist

What stands between this repository and flipping it to public, written so a
later session can pick it up cold. Delete this file when the repo is public and
the list is empty; it is a working document, not documentation.

**State on 2026-09-17:** private repo, one author. The `public-prep` PR did the
first pass below; the `codex-epic` branch added the Codex runner, mixed-agent
epics, the manual and the site.

## Done in the first pass

- [x] `LICENSE` (MIT) and `"license"` in `package.json`.
- [x] Project-neutral naming: `withGodotLock` → a real `max_local_jobs`
      semaphore (the old setting was never read: the lock was a plain mutex),
      `concurrency.max_godot_jobs` → `max_local_jobs` with a schema-2
      migration, the unused `godot_bin` local key removed, default categories
      no longer a game studio's.
- [x] The one-off importer moved to `packages/server/src/import/legacy/` with a
      header saying what it is and that only its shape is worth copying.
- [x] Home-directory paths scrubbed from `docs/notes/sdk-notes.md` and the spike
      (which now requires `SPIKE_CWD` instead of defaulting to one).
- [x] `planestro sample` / `npm run sample`: a seeded fictional project that
      runs the whole lifecycle in dry-run with no repo, remote or login; the
      dry-run world is rebuilt from the items on restart; `sample.test.ts`
      keeps it working.
- [x] README rewritten for someone who has never seen the tool, led by the
      one-minute demo, with two screenshots taken from the sample.
- [x] GitHub Actions CI (typecheck, tests, build) on PRs and `main`.

## Decisions only the author can make

- [x] **MIT.** Confirmed by the author on 2026-09-22; `LICENSE` and `package.json`
      already say so.
- [x] **Name the game.** Decided 2026-09-22: yes. The README links Hurricane
      Harrison, and the resume names both.
- [ ] **Commit email.** Every commit carries a personal Gmail address. Fine for
      most people; if not, it needs a history rewrite (see below) and a
      GitHub `noreply` address going forward.
- [ ] **The name.** `planestro.com` was registered on 2026-09-22 (Route 53). Still
      check `planestro` on npm, GitHub and as a trademark before it is attached to a
      public identity. (`package.json` stays
      `"private": true` either way until publishing to npm is a decision.)
- [x] **Keep or rewrite history.** Kept, with contents scrubbed (see the
      audit): the commit log is interview material — the bug stories below
      each have a commit to show — so it was rewritten rather than squashed.

## History audit (do this before the flip — it is the irreversible part)

Making the repo public publishes every commit, not just `main`'s tip.

- [ ] `git log --all -p | grep -nE "sk-ant-|ghp_|gho_|github_pat_|BEGIN (RSA|OPENSSH|EC) |AKIA|xox[bp]-"`
      — clean on 2026-09-22 (the only hits are this checklist and the `sk-ant-…`
      placeholder in Settings). No home paths or game names in any blob either.
      Still to do once: `gitleaks detect` or `trufflehog git file://.` (neither
      is installed yet) for a real scan.
- [x] History scrubbed on 2026-09-17: every commit's files were rewritten
      (`git filter-branch`, fixed string rules) so no blob or message in any
      commit names the project planestro was built for or a home directory;
      commit count, order, authorship and messages are otherwise unchanged. No
      commit *message* ever named it — item ids like `HH-9` remain and are the
      same example prefix the docs use. A pre-rewrite bundle is kept outside
      the repo by the author; never push it.
- [x] Pre-rewrite commits: the closed PR #1 (`public-prep`) still shows 36 of them,
      and they name the game and one home-directory path. The game is named
      publicly now, so this is harmless: **flip this repository**; no new repo is
      needed. PRs #2–#4 are post-rewrite and clean (checked 2026-09-22).
- [x] `git branch -a` and `git tag`: on 2026-09-22 only `main` exists, locally and
      on the remote, and there are no tags. Re-check at the flip.
- [x] Confirm the *data* never lived here (checked 2026-09-22): the planning data dir is an orphan
      branch of the game's repo, not of this one. `git log --all --stat -- items prompts journal` should be empty apart from
      `packages/server/prompts/` (the shipped defaults).
- [ ] Read the shipped default prompts (`packages/server/prompts/*.md`) once as
      a stranger would: they are the most-read "source" in the repo.

## Repository hygiene

- [x] `AGENTS.md` is a byte-identical copy of `CLAUDE.md` (Codex reads the former),
      held together by `docs.test.ts`.
- [ ] `CONTRIBUTING.md` — or a plain sentence in the README that this is a
      personal tool and PRs may sit. Setting expectations beats a template.
- [x] `SECURITY.md`: reporting and the threat model. Then turn on **private
      vulnerability reporting** (Settings → Code security) at the flip, since
      SECURITY.md points people to it.
- [ ] Issue templates are optional; turning **off** the wiki/projects/
      discussions tabs you will not tend is not.
- [ ] Branch protection on `main` requiring the CI check. (CI is green on
      Linux as of the `public-prep` PR; its first run found the one assumption
      — a git identity — and the sample now supplies its own.)
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
- [x] **Other websites could drive the UI** (found 2026-09-22): a cross-site POST
      with `text/plain`, a DNS-rebinding `Host` and a cross-site WebSocket all
      worked against `127.0.0.1`. Now refused by `guard.ts` (Host allowlist,
      `Origin` / `Sec-Fetch-Site` checks), with `allowed_hosts` for extra names.
- [ ] **An access token for non-loopback use.** With `--host 0.0.0.0` anyone on
      the network can still drive it. Jupyter's shape fits: a random token,
      printed once, exchanged for an HttpOnly cookie, required whenever the bind
      address isn't loopback.
- [ ] **Model ids are hardcoded in the init template** (`claude-fable-5`,
      `claude-opus-5`). They age; `init` could ask `claude` what exists, or the
      README should say where to edit them.
- [ ] **The dry-run planner's plans are stubs** (the dry-run *art* is now a real generated picture, and the epic breakdown is a plausible canned one) ("1. Inspect the code…"). For the
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

- [ ] **Retake the screenshots.** `docs/img/item.png`, now the README's lead image,
      predates the Releases tab and the id-before-title header, and shows the
      stub dry-run plan. Retake it (and `board.png`) after the canned,
      item-aware dry-run plans exist.
- [x] **README leads with the pipeline, not the art** (2026-09-22): the audience
      is web and API developers. Codex is a peer implementer; art-plus-code
      features are one section, with Hurricane Harrison as the proof. The site
      (`site/index.html`) still leads with the art story.

- [ ] A two-minute screen recording of the sample: queue → plan → approve →
      PR → CI red → fixed → merged → done (`PLANESTRO_DRYRUN_CI=red-once`
      gives the red run). Link it at the top of the README.
- [ ] A second, real recording: one actual item on the real project, sped up,
      showing a parked question and a resume after restart — the part that is
      hard and that the fake cannot show.
- [x] `docs/architecture.md` — and a whole manual under `docs/`, held to the
      code by `docs.test.ts`.
- [ ] A short write-up of three war stories already in the git log — the stale
      base-red gate, the double-counted CI run, budget caps that surfaced as
      `no_plan` — each is a "tell me about a bug" answer with a commit to show.
- [ ] Numbers from real use: items shipped, PRs merged, median queue-to-merge
      time, spend per item. The journal and item files already hold all of it;
      a `planestro stats` command would make the README's claim checkable.

## The site

- [x] `site/` — a static marketing page, and `.github/workflows/pages.yml` to publish it.
- [ ] Turn it on: Settings → Pages → *Build and deployment: GitHub Actions*; then
      Settings → Secrets and variables → Actions → Variables → `PAGES_ENABLED` = `true`;
      then run the *Pages* workflow once (or push a change under `site/`). Pages on a
      private repository needs a paid plan — on a free plan this waits for the flip.
- [ ] After the first deploy: put the Pages URL in the repository's "About" box and make
      `og:image` an absolute URL (share cards ignore relative ones).
- [ ] **Domain: `planestro.com`, to be hosted on AWS** (registered 2026-09-22 in
      Route 53). That replaces the GitHub Pages plan above: decide the AWS shape
      (S3 + CloudFront with an ACM certificate is the usual one for a static
      `site/`), then point `pages.yml` at it or replace it with a deploy workflow,
      and make `og:image` an absolute `https://planestro.com/…` URL.

## The flip itself

1. Land everything above that is marked a blocker for you.
2. Re-run the history audit on the exact commit range being published.
3. If rewriting: fresh repo or `git checkout --orphan`, one commit, force-push
   while still private; re-clone every worktree.
4. Settings → change visibility. Then: check the README renders (images,
   badge), the Actions tab runs, and clone it logged-out.
5. Run `npm run sample` from that fresh clone on a machine that has never seen
   the project. That is the interviewer's experience.
