# CLI

```sh
npm run planestro -- <command> …        # or: npx tsx packages/server/src/cli.ts <command> …
```

| Command | |
|---|---|
| `init <data_dir> --repo <code_repo>` | Create (or top up) a data dir. `--name`, `--prefix HH`, `--default-branch`, `--release-branch`, `--github owner/repo`, `--no-commit`. Idempotent: adds what is missing, never overwrites. Remembers the project in `~/.planestro` so a bare `serve` finds it. |
| `serve [data_dir]` | The web UI and the engine. `--port N` (4300), `--host H` (127.0.0.1; `0.0.0.0` for your LAN — the UI has no authentication), `--mock` (no engine, UI only), `--open` (open a browser once it is up), `--watch` (see [Operations](operations.md#watch-mode)). |
| `sample [dir]` | Build the fictional *tidepool* project and serve it in dry-run on port 4310. `--reset` rebuilds it, `--no-serve` only builds it, `--port N`. |
| `check [data_dir]` | Validate every file and report; commits hand edits as `manual: …`. |
| `migrate [data_dir]` | Apply schema migrations. An older data dir is read-only until this is run. |
| `reconcile [data_dir]` | One reconciliation pass against git and GitHub, printing each correction. |
| `import-prompts <file> --data <dir> [--commit]` | Legacy, project-specific importer kept as an example (`src/import/legacy/`). Dry-run unless `--commit`. |
| `version` | |

With no `data_dir`: `PLANESTRO_DATA_DIR`, then a `planestro.yml` in the current directory,
then the most recently used registered project.

| npm script | |
|---|---|
| `npm start -- <data_dir>` | `serve` |
| `npm run dev` / `npm run dev:web` | `serve` under `tsx watch`; Vite on :5173 proxying to :4300 |
| `npm run sample` | `sample` |
| `npm run build` | the web UI into `packages/web/dist` (the server serves it) |
| `npm test`, `npm run typecheck` | |
| `npm run spike`, `spike:codex`, `spike:codex-live` | the Agent SDK spike, the Codex spike, the live Codex acceptance runs (these spend real quota) |

Environment: `PLANESTRO_HOME` (where the project registry lives), `PLANESTRO_DATA_DIR`,
`PLANESTRO_DRYRUN_CI=red-once|conflict-once` (make the dry-run world
fail CI once, or conflict once, to watch the recovery paths).
