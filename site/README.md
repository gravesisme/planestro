# The Planestro marketing site

The replacement homepage and blog are being reviewed in
[`gravesisme/planestro-site`](https://github.com/gravesisme/planestro-site).
This copy remains available until the reviewed site is ready for cutover. The
quick start stays in this code repository, tied to releases; the new marketing
site links to the release branch’s Getting started guide.

Static HTML, CSS, local JavaScript, and local images. No build step, framework,
external fonts, analytics, or runtime services. Serve **this directory as the
web root**; root-relative assets target planestro.com, not a GitHub project
subpath. Opening the HTML with file:// is not supported.

From the repository root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory site
```

Open http://127.0.0.1:8765/. The four routes are `/`, `/quick-start/`, `/blog/`,
and `/blog/building-an-ai-fleet/`. Directory indexes support direct navigation.

## Editing

- `styles.css` supplies the shared white/ink/blue visual system and site shell.
  The article loads its imported `article.css` first to preserve its approved
  diagrams and editorial layout. Keep shared shell changes scoped to their classes.
- `site.js` enhances command copy buttons and screenshot dialogs. The article's
  `script.js` owns its nine-slide carousel, progress bar and contents.
  Navigation and the article text do not require JavaScript; no-script visitors
  see all nine captures. Clipboard failure leaves manually selectable commands.
- All four headers/footers are static HTML; update them together. There is no
  client-side page router or dynamically fetched navigation.
- The article and files under `assets/` came from the approved October 2, 2026
  Planestro-Blog-Handoff-v2 (source 5eb4f0497b066c17b70d50e2d3ae96fe7274433e).
  Its title, date, wording, diagrams, captions, metrics and caveats are approved
  copy, with an approved October 5 refresh against engine commit `2cfde13`.
  That refresh updates CI recovery, hold semantics, lost-report recovery, bounded
  iteration, and merge/cleanup safeguards, and removes game-specific CI setup
  and roadmap details. The original publication date and dated evidence remain;
  the byline and metadata record the update separately. Keep the planned articles
  unlinked, and preserve the historical context.
- `packages/server/test/fixtures/blog-content.sha256` records normalized text
  inside the original article's main element. The test protects against accidental
  editorial changes during integration. Change the digest only with an approved
  article revision; never simply to make an unexpected copy difference pass.
- Existing `img/` files remain available for old links. Supplied captures are
  historical, not claims about the current sample or live UI.
- Share-card JPEGs have matching SVG sources in `assets/`. They use the site's
  typography and palette; regenerate the JPEGs when editing the SVGs.

## Validation

`npm test -- packages/server/test/site.test.ts` checks all routes, links,
fragments, local runtime resources, image descriptions, metadata, editorial
integrity, and setup boundaries. Run the complete `npm test`,
`npm run typecheck`, and `npm run build` before submitting a PR.

Browser-check at 1440, 768 and 390 pixels (also 320 for overflow):

- Every route, its navigation, screenshots, tables, command blocks, and footer.
- Nine carousel labels, Previous/Next wrap, counter, Arrow/Home/End navigation,
  horizontal mobile labels, and full-screenshot controls.
- Branching epic workflow and expandable child-workflow details, evidence
  disclosures, reading progress, and direct
  article anchors. Close dialogs by button, Escape and backdrop; focus returns
  to the opening control.
- The quick-start copy buttons and manually selectable fallback. Expand the
  new-project recipe. Check the article at reduced motion and system dark mode:
  the design remains light.

Verify the guide in temporary sibling directories. Run the starter project's
real test and initialize/check a Git-versioned planning directory. Use dry-run
or the sample for lifecycle checks. Do not create GitHub repositories or run paid
agents merely to test documentation; explicitly report those live steps as
unverified. The GitHub snippet is an intentional user action, not an installer.

## Release boundary

The repository was private and `PAGES_ENABLED` was unset at implementation.
Copy therefore says Planestro v1.0.0 is coming soon and installation requires
repository access. The public release is planned alongside Hurricane Harrison
v1.6.0 while remaining bugs are worked through; this is a plan, not a dated
launch commitment. The article’s `#release` section holds the full announcement.
The quick start uses existing local Claude Code
and optional Codex logins; Planestro has no account or login screen. There is
no signup form or backend.

The existing `.github/workflows/pages.yml` can publish this directory once
configured. This change does **not** enable it, set a custom domain, change DNS,
change repository visibility, or deploy anything. Before public launch, resolve
repository access/release readiness, configure Pages and planestro.com (including
HTTPS), and recheck all canonical/share URLs and external setup documentation.
