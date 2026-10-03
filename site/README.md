# The Planestro marketing site

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
  `script.js` owns its stage tabs, six-slide carousel, progress bar and contents.
  Navigation and the article text do not require JavaScript; no-script visitors
  see all six captures. Clipboard failure leaves manually selectable commands.
- All four headers/footers are static HTML; update them together. There is no
  client-side page router or dynamically fetched navigation.
- The article and files under `assets/` came from the approved October 2, 2026
  Planestro-Blog-Handoff (source e8f72805323007b9c929e6c9272db9dee973ac89).
  Its title, date, wording, diagrams, captions, metrics and caveats are approved
  copy. Keep the planned articles unlinked, and preserve the historical context.
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
- Six carousel labels, Previous/Next wrap, counter, Arrow/Home/End navigation,
  horizontal mobile labels, and full-screenshot controls.
- All stage tabs by keyboard, evidence disclosures, reading progress, and direct
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
Copy therefore says a public early release is forthcoming and installation
requires repository access. The quick start uses existing local Claude Code
and optional Codex logins; Planestro has no account or login screen. There is
no signup form or backend.

The existing `.github/workflows/pages.yml` can publish this directory once
configured. This change does **not** enable it, set a custom domain, change DNS,
change repository visibility, or deploy anything. Before public launch, resolve
repository access/release readiness, configure Pages and planestro.com (including
HTTPS), and recheck all canonical/share URLs and external setup documentation.
See `docs/going-public.md` for the broader release checklist.
