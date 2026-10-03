# Public-release readiness checklist

Reviewed **2026-10-03**, against **`90f7dd1`**. The repository is still private.
This replaces the September checklist, whose branch inventory, installation
notes, and marketing-site work were out of date. Evidence under R1–R5 describes
the reviewed baseline; their checkboxes record the subsequent fixes.

**R1–R5 are implemented in this worktree; merge the reviewed fixes before
inviting people to run Planestro. Complete R6–R10 before the public release.** Repository visibility and marketing-site
publication are separate actions. Neither was changed by this review.

Planestro remains a local, single-user tool with no Planestro account or login.
None of this checklist requires adding an account system or making API keys a
prerequisite. The review focuses on safe local operation and reliable automation.

## First: security and data-loss fixes

### R1 — P1: prevent attachment scripts from controlling Planestro

- [x] Serve untrusted active content safely, and add a regression test for direct
      navigation to an uploaded SVG.

**Evidence:** [attachment response](../packages/server/src/routes/api.ts#L448)
serves SVG as `image/svg+xml` on the application's own origin, without a sandbox
CSP or download disposition. A disposable store accepted an SVG containing a
script and returned it unchanged with HTTP 200. An item offers an **open** link
to managed attachments.

**Impact:** opening an SVG supplied by an agent or copied from elsewhere can run
script with the same origin as the unauthenticated control API. The Host/Origin
guard cannot distinguish that script from the UI. This concerns opening the SVG
as a document; SVG displayed only as an image has different restrictions.
[Browser behavior reference](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image).

**Done when:** unsafe formats download or render in an isolated, sandboxed
context; responses have appropriate content types and `nosniff`; a browser test
proves a malicious attachment cannot read state or perform an API mutation.
Verified after the fix with a disposable browser fixture: opening an SVG with
an API-calling script left the fixture page in place and made zero script API
calls. Automated tests verify the download, sandbox and nosniff headers. The
live instance was not used.

### R2 — P1: enforce the attachment directory boundary

- [x] Validate attachment IDs and resolve filesystem paths before serving them.

**Evidence:** [path validation](../packages/server/src/routes/api.ts#L449) uses
string `startsWith` and does not resolve symlinks. Local probes returned HTTP 200
and marker contents for both:

- `/attachments/..%2Fattachments-extra/probe.txt`, reading a sibling directory
  whose name happens to begin with `attachments`;
- a file inside an item's attachment directory symlinked to a file outside it.

**Impact:** a caller admitted by the request guard can read files outside the
intended attachment tree. This does not by itself bypass the request guard.

**Done when:** IDs match known items, the resolved target is a regular file within
the resolved attachment root using a separator-aware containment check, and
encoded traversal, sibling-prefix and symlink escape tests are rejected. Apply
consistent boundaries to managed attachment write/remove paths as well.

### R3 — P1: keep machine-local settings out of every automatic commit

- [x] Repair missing ignore rules during initialization and refuse to
      automatically commit or push tracked machine-local settings.

**Evidence:** [init](../packages/server/src/init.ts#L35) never updates an existing
`.gitignore`, then [stages everything](../packages/server/src/init.ts#L142).
[Checkpoints](../packages/server/src/store/GitCommitter.ts#L49) also stage everything.
A temporary planning repository with an existing `.gitignore` and a dummy
`planestro.local.yml` committed that local file during init. A subsequent
checkpoint committed changes to the dummy credential too.

**Impact:** local paths and optional MCP/API credentials can enter planning Git
history and its configured remote. The current user's subscription setup does
not require an API key; this bug also affects other machine-local settings.
`SECURITY.md` currently promises this file is never committed or pushed.

**Done when:** init preserves custom ignores while adding the required exclusions;
startup/init detect an already tracked local file and stop unsafe automatic
commits/pushes with an actionable message; regression tests cover existing ignores,
tracked local files and checkpoints. Keep any credential-removal/history cleanup
as an explicit user action. Write secret-bearing local files with owner-only
permissions on supported systems.

### R4 — P1: merge only the exact commit that passed checks

- [x] Carry the verified head SHA through the merge port and require GitHub to
      match it atomically when merging.

**Evidence:** [engine merge](../packages/server/src/engine/LiveEngine.ts#L1736)
calls [LiveGhPort.mergePr](../packages/server/src/engine/live-ports.ts#L317), whose
contract carries only the PR number and a branch-deletion flag. It invokes
`gh pr merge` without an expected head. Earlier checks do not close the interval
between validation and this mutation.

**Impact:** if another process pushes during that interval, a repository without
sufficient branch protection can merge a commit Planestro did not verify.
The fix is covered by a mocked GitHub-command test and an engine regression
that changes the head at the final merge call. No live GitHub race was induced.

**Done when:** use `--match-head-commit` or the equivalent API SHA precondition;
head movement blocks for inspection and fresh validation without merging; tests move the head after
CI validation and prove the merge is refused. [GitHub CLI reference](https://cli.github.com/manual/gh_pr_merge).

### R5 — P1: delete only the branch tips that cleanup proved safe

- [x] Make deletion conditional on the proven tip, and keep remote branch
      deletion inside the positive-evidence cleanup path.

**Evidence:** [cleanup](../packages/server/src/engine/LiveEngine.ts#L2075)
checks ancestry, performs other operations, then rechecks only remote-branch
existence and calls an [unleased delete](../packages/server/src/engine/live-ports.ts#L219).
A probe using the real engine and its in-memory ports advanced the remote branch
to an unmerged commit during worktree removal. Cleanup deleted that new tip and
marked the item `FINISHED`.

Also, the merge call requests `--delete-branch` before the subsequent cleanup
proof, and local deletion uses `git branch -D` without an expected tip.

**Done when:** reuse the existing `deleteRemoteBranchAt` lease with the SHA whose
ancestry was checked, condition local ref deletion on its proven SHA, and block
on movement or ambiguous evidence. Remove the merge-time deletion shortcut.
Regression tests cover remote/local advancement, remote branch recreation, and
retries after a transient failure. Preserve the existing fresh-fetch, merged-PR,
ancestry, dirty-tree, and displaced-file checks.

## Before public release

### R6 — P2: resolve or explicitly triage dependency advisories

- [ ] Update the lockfile for patchable runtime dependencies and assess the
      Vitest upgrade; record any accepted, unreachable advisories with reasons.
- [ ] Add recurring dependency-update automation and a dependency/security check
      with a documented handling policy.

`npm audit` on 2026-10-03 reports **five affected packages: one high, four
moderate**. This is an inventory, not evidence that every advisory is exploitable
through Planestro.

| Locked dependency | Audit result | Follow-up |
| --- | --- | --- |
| `fast-uri@3.1.6` | High; URI authority/host handling | Update the transitive dependency under MCP SDK / ajv; check all applicable advisories. |
| `hono@4.13.5` | Moderate; JSX boundary escaping | Update. Planestro uses a React frontend, so the vulnerable JSX path was not shown reachable. |
| `ip-address@10.7.0` | Moderate; address checks / oversized input | Update the MCP SDK transitive dependency and assess its actual use. |
| `vitest@3.2.7`, `@vitest/mocker` | Moderate; redirect-mock file access | Assess patched-version migration. The two package entries share an advisory; ordinary test execution was not shown exploitable. |

### R7 — P2: finish the publication privacy review

- [x] Scan a fresh GitHub mirror with Gitleaks 8.30.1, default rules, all refs,
      and redacted output: **zero findings**. The downloaded binary's archive
      checksum matched the official release manifest.
- [x] Inventory advertised refs: **27 branches, 118 pull-request refs, no tags**;
      371 reachable commits, with 356 commits reported scanned by Gitleaks.
- [x] Confirm publication of the personal commit email and historical home paths
      is acceptable. Historical paths remain in versions of
      `docs/notes/dogfood-crystal-cavern.md` and `spikes/sdk-spike.ts`; a clean
      current checkout does not erase PR history. Confirmed acceptable by the
      repository owner on 2026-10-03.
- [x] Review public-facing PR/issue text, uploaded images, Actions logs/artifacts
      and screenshot contents. Those are outside a Git text-secret scan. Marked
      complete on the repository owner's confirmation on 2026-10-03.
- [ ] Re-run the redacted all-ref scan against the final release commit and any
      newly pushed branches. Keep planning data and the pre-rewrite backup bundle
      out of this repository. Do not rewrite history merely because old refs exist.

The scan found no historical files matching the checked local-config, environment,
private-key, item-file or journal-file naming patterns. This is useful evidence,
not a guarantee that no private information exists. Prior decisions to use MIT,
name Hurricane Harrison publicly, and retain history remain in force.

### R8 — P2: make the first-run documentation consistent

- [ ] Correct the remaining [README authentication section](../README.md#authentication-and-billing),
      which still tells users to set a Console API key. Match the local-login
      quick start; retain optional configuration documentation accurately.
- [ ] Remove `--host 0.0.0.0` from routine background-start examples. Keep the
      ordinary public path on loopback, and make the lack of network access
      control explicit wherever LAN access is discussed. No account system is
      needed for the local-only release.
- [ ] Recommend a separate, private Git repository for planning data. Explain
      that an orphan branch in a public code repository is also public if pushed;
      isolation from the default branch is not confidentiality.
- [ ] Declare the supported Node version in package metadata, matching Node 24
      in CI/docs. Keep macOS support and Linux/Windows limitations explicit.
- [ ] Add contribution/support expectations in `CONTRIBUTING.md` or a concise
      README paragraph; retain the existing personal-project support scope.
- [ ] Repeat fresh-clone installation, sample, and new-project initialization on
      the final revision. Before recommending live use, separately validate one
      small real Claude task and optional Codex implementation, including approval,
      pause/restart, CI, merge and cleanup. That requires an authorized live trial;
      this review made no paid agent calls or GitHub test repositories.

Clone + install + build is an acceptable first-release distribution. npm publishing,
Codex-only orchestration and multi-project servers are not prerequisites. The
server package already has a `bin` entry, contrary to the old checklist.

### R9 — P2: prepare GitHub's public-repository controls

- [ ] Require the `check` CI status on the default branch and restrict force-push
      and deletion. The branch API currently reports **`protected: false`**.
      Protection/ruleset APIs returned a private-repository plan restriction;
      apply this at the visibility change if unavailable beforehand.
- [ ] Enable private vulnerability reporting and verify that the reporting path
      promised by `SECURITY.md` actually appears. Its API returned 404 here, so
      enablement is unverified.
- [ ] Enable the available secret-scanning, push-protection and dependency-alert
      features; verify public-fork workflow behavior and avoid giving untrusted
      PR jobs secrets or a privileged persistent runner.
- [x] Default Actions token permissions are read-only; Actions cannot approve PRs.
      CI uses `pull_request`, not `pull_request_target`.
- [x] MIT license, repository description, CI workflow and security policy exist.
      Wiki and discussions are disabled.
- [ ] Decide whether to keep the enabled Projects feature; set useful topics and
      a repository social preview. These presentation settings can follow release.

### R10 — final release checkpoint

- [ ] Complete R1–R9's required fixes/checks, with any accepted exceptions recorded.
- [ ] Run tests, typecheck, build, dependency audit and the all-ref secret scan on
      the exact commit to release. Record supported agent CLI/SDK versions.
- [ ] Add release notes describing experimental status, local trust boundaries,
      supported platforms, installation, backup/upgrade and known limitations.
      A `v0.1.0` tag is useful; npm publication is a separate decision.
- [ ] Change visibility only when explicitly authorized. Then verify an anonymous
      clone, README image/link rendering, the sample, security reporting and
      required CI. Do not publish a runtime port or planning repository with it.

## Marketing-site launch — separate from repository visibility

Publish the existing marketing site from `site/`. The Pages workflow uploads
that directory as-is; it does not generate a replacement site or apply a GitHub
theme. Pages, domain, DNS and HTTPS settings make those same pages available at
`https://planestro.com`. Keep the deployment source set to GitHub Actions and
the artifact path set to `site/`.

- [x] Homepage, quick start, blog index and approved full article are implemented.
      Canonical and social-image URLs already target `https://planestro.com`.
- [ ] Enable GitHub Pages for Actions and set `PAGES_ENABLED=true` when ready.
      The variable is currently absent; the Pages API returned 404.
- [ ] Configure and verify the custom domain, DNS and HTTPS using the hosting
      provider's current instructions. The repository has no `site/CNAME` yet.
      This review did not change DNS or check the registrar account.
- [ ] Serve the site at the domain root: assets are root-relative, so a default
      `/planestro/` project-site URL alone is insufficient. Verify all four routes,
      direct article anchors and social-preview images after deployment.
- [ ] Once public access works, replace the site's private-access/forthcoming
      notices. The repository's homepage already points to `https://planestro.com`.

## Improvements that can follow the first release

- [ ] Split the web bundle if useful: the production build currently emits an
      approximately 883 kB JavaScript chunk (276 kB gzip). This is not a release blocker.
- [ ] Improve board keyboard reordering and review dialog focus behavior. Existing
      item actions offer alternatives; the board currently uses `PointerSensor` only.
- [ ] Bound upload bodies before multipart parsing/buffering; the current managed
      file-size check happens after the body is in memory.
- [ ] Add more convincing sample plans, refresh older demo screenshots, and record
      a short walkthrough. Keep claims about historical screenshots accurate.
- [ ] Consider packaging convenience and further platform coverage after the
      documented clone-based workflow is reliable.

## Review evidence and limits

- Baseline review, `npm test`: **609 tests passed across 61 files**.
- `npm run typecheck`: **passed**.
- `npm run build`: **passed**, with the bundle-size warning noted above.
- `npm run sample -- <temporary-directory> --no-serve`: **passed**, 14 items seeded.
- Attachment boundary/settings probes used disposable repositories and dummy
  strings. The original cleanup probe used in-memory Git/GitHub ports. Fix
  regressions additionally exercise branch deletion in disposable local Git
  repositories, with a local bare remote; no GitHub branches were deleted.
- Gitleaks inspected GitHub's advertised Git refs, not GitHub comments, binaries
  or every server-retained unreachable object. No matching secrets were found.
- This was a targeted source review of server boundaries, storage/init, agent
  launch policy, merge/cleanup, docs and release configuration, backed by the
  existing full test suite. It is not an exhaustive security audit or a fresh
  live-agent/platform/browser certification.

R1–R5 fixes: attachment downloads and shared filesystem boundaries; protected
planning Git operations and private local-file permissions; exact-head merges and
conditional branch deletion (including discard/unused-worktree cleanup). New
regressions use dummy credentials and local or in-memory Git only. Focused
regressions, type checking and the production build pass. The SVG browser fixture
made zero API calls after opening the attachment. See the implementation PR for
the final full-suite and CI results.

Remaining implementation order: dependencies and docs (R6/R8), then the final
privacy and GitHub release checks (R7/R9/R10).
