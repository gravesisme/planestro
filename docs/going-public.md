# Public v1.0.0 release checklist

Updated 2026-10-20 against `5d13350`. The public opening is **v1.0.0**.
This is the current gate; the [October 8 audit](notes/public-readiness-2026-10-08.md)
is historical evidence, not an outstanding-work list.

## Already landed

Initialization and base resolution (#332), consistent provider setup (#333), contributor
and dependency hygiene (#334), running-mode indicator (#335), bounded uploads (#336),
local preflight (#337), person-owned holds and submission restrictions (#339), untrusted
input hardening (#340), device pairing (#403), and release/development branching (#443).

At `5d13350`, [CI passed](https://github.com/gravesisme/planestro/actions/runs/39537979375)
(install, typecheck, lint, full tests, build). A fresh `npm audit --json` reported zero
known vulnerabilities. This is not a fresh secret scan or live-provider certification.

## Before the release PR

- [ ] Complete the product-led homepage and current sample captures in
  `gravesisme/planestro-site`; review desktop and mobile. Marketing and blog deploy
  independently; the code repository owns versioned setup documentation.
- [ ] Merge the documentation corrections: release-branch clone, Codex approval support,
  provider-neutral orchestrator wording, honest sample timing, backup/restore procedure.
- [ ] Record a fresh Claude-only acceptance run and a Codex app-server-only run on the
  release candidate: clean install, preflight, plan, approval, implementation, held PR,
  CI, reviewed merge, cleanup. Do not count dry-run simulations as live evidence.
- [ ] Exercise a non-default base, dependency setup, a persisted decision across restart,
  CI failure/recovery, pause/resume and refusal to remove unexpected local work.
- [ ] Refresh the redacted all-ref secret scan. Review new issue/PR prose, media and
  Actions logs/artifacts since the prior audit. Keep planning data and backups private.
- [ ] Prepare v1.0.0 metadata, release notes, known limitations, supported CLI/SDK versions,
  and install/update/backup instructions. State the support scope: macOS used daily,
  Linux tested in CI, Windows unverified; single-user local operation.

## At publication

- [ ] Refresh CI and advisory/scan evidence on the actual release revision.
- [ ] Merge the release PR from `develop` to `main`, tag v1.0.0 and publish release notes.
- [ ] Change code-repository visibility only on the owner's explicit instruction.
- [ ] Protect `main` and `develop`: require `check`, prevent force pushes/deletions,
  and restrict release PR sources to `develop` or `hotfix/*` as intended by #443.
- [ ] Enable and verify private vulnerability reporting and available security scanning.
  Before the flip, both branches were unprotected; the reporting endpoint returned 404.
- [ ] Verify anonymous clone from `main`, sample startup, README images/links and required CI.
- [ ] Configure the separate site's Pages deployment, domain and HTTPS. Check all routes,
  mobile layout, share cards and links to versioned docs. Hosting remains unverified.
- [ ] Update every availability notice together after access changes. Preserve the dated
  article's historical announcement and append a dated release update deliberately.

## Evidence to keep with the release

Record commit, date, platform, Node, agent CLI/SDK versions, CI URL, advisory and scan
results, acceptance outcomes and accepted exceptions. An empty checkbox means evidence
has not been recorded here; it does not prove the feature is broken.

## After v1.0

Guided onboarding, a simpler new-item flow, an unassisted user study, packaging,
bundle splitting and additional platforms can follow actual usage. They are not
prerequisites for this release. Live acceptance runs are deferred while the site and
documentation are finished, at the owner's request on 2026-10-20.
