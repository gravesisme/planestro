# The planestro site

A static page: `index.html`, `styles.css`, images. No build step, no JavaScript, no request to any
other host (fonts are system stacks). Open `index.html` in a browser to review it.

- The hero is an inline SVG score; its one animation respects `prefers-reduced-motion`.
- Screenshots in `img/` are copies of `docs/img/` (taken from `npm run sample`);
  `codex-header.jpg` and `codex-icon.png` were drawn by the Codex CLI during the live
  acceptance run (`npm run spike:codex-live -- epic`).
- `og.png` is the 1200×630 share card.
- `packages/server/test/site.test.ts` fails if the page references another host or a local
  file that does not exist.

Deployment: `.github/workflows/pages.yml` publishes this folder to GitHub Pages on pushes to `main`
that touch it — once the repository variable `PAGES_ENABLED` is `true` and Pages is set to deploy
from GitHub Actions. Until then the job is skipped, not failed.
