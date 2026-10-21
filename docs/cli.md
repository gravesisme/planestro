# CLI

```sh
npm run planestro -- <command> …        # or: npx tsx packages/server/src/cli.ts <command> …
```

| Command | |
|---|---|
| `init <data_dir> --repo <code_repo>` | Create (or top up) a data dir. `--name`, `--prefix HH`, `--provider claude\|codex` (who plans, implements and orchestrates; default claude), `--default-branch`, `--release-branch`, `--github owner/repo`, `--no-commit`. Idempotent: adds what is missing, never overwrites. Creates the planning Git repository a new folder lacks and commits the seed. Remembers the project in `~/.planestro` so a bare `serve` finds it. (`--layout` is withdrawn: a value other than `dir` is refused with what to do instead.) |
| `check [data_dir]` | Validate every file and report, with the access settings (`lan_access`, the bind address, the link address notifications use). Opening the data dir commits hand edits as `manual: …`. Exits 1 when a file is invalid. |
| `check [data_dir] --preflight` | What a first task would stop on, found on this machine with no model call (#337): Node, git and its identity, the code repo's HEAD, remote and base branch, `gh` sign-in, the `claude` / `codex` CLIs the models use and their sign-in, named accounts, the planning repo, the port, a worktree setup hook. Each problem comes with its repair. `--offline` skips the network checks, `--port N` (4300) the port to check, `--host H`, `--json` for scripts. Read-only; exits 1 when something would stop a task. |
| `migrate [data_dir]` | Apply schema migrations. An older data dir is read-only until this is run. |
| `reconcile [data_dir]` | One reconciliation pass against git and GitHub, printing each correction. |
| `serve [data_dir]` | The web UI and the engine, in the foreground. `--port N` (4300), `--host H` (127.0.0.1, or `0.0.0.0` when `lan_access` is set in `planestro.local.yml`), `--mock` (no engine, UI only), `--open` (open a browser once it is up), `--watch` (restart on planestro source changes between agent turns and rebuild the UI; see [Operations](operations.md#watch-mode)). A bind other than loopback answers only local-network and Tailscale addresses, and every request not from this machine must carry a paired device's token (see `pair` and [SECURITY.md](../SECURITY.md)). |
| `start [data_dir]` | Run `serve` in the background, in a session of its own (it outlives the terminal); returns once the server answers, then reconciles and prints the corrections. `--port N`, `--host H`, `--watch`. Already running there: prints it and exits 0. Refuses a data dir or port held by anything else. Log: `<data_dir>/.planestro/serve.log`. |
| `stop [data_dir] \| --port N \| --all` | Stop that server's whole process group (SIGTERM, then SIGKILL after 15 s); with no argument, the data dir in this directory. Never stops anything it cannot identify as the server asked for. |
| `status [data_dir]` | Every running instance on this machine: data dir, URL, pid / process group, uptime, log. `--json` for scripts (one record, or `null` with exit 3, when a data dir is given). Servers started with `serve` rather than `start` are not listed. |
| `sample [dir]` | Build the fictional *tidepool* project and serve it in dry-run (default dir `.planestro/sample`, port 4310): no repo, GitHub remote or agent login needed. `--reset` rebuilds it, `--no-serve` only builds it, `--port N`. |
| `permissions suggest [data_dir]` | Allow rules suggested from past permission rulings (#169): safe kinds of command that keep being approved, each replayed against every past ruling so none would have allowed anything ever denied; also redirect candidates (kinds of command denied every time) and drift (rules nothing ran under, approvals rising) (#203). `--json`, `--min N`. Read-only: add the ones you accept in Settings. |
| `import issues [data_dir] [N …]` | File GitHub issues of `code_repo.github` as items, unsubmitted (#231): the numbers given, or every open issue with `--label L` (default `issues.import_label`). One already imported is skipped. `--closes`: their PRs say `Closes #N`. Goes through the running server when there is one (for one started with `serve`, name its `--port`). |
| `pair [data_dir]` | Ask the running server, from this machine only, for a one-time code (10 minutes) that pairs another device with it (#403), with `/pair?code=…` links for the addresses a device can reach it at (none on a loopback bind). The device trades the code at `/pair` for a token; revoke a device in Settings → Access. `--port N` names a server started with `serve`. |
| `notify <title> <message>` | Show a desktop notification (`osascript` on a Mac, `notify-send` on Linux); meant for the `notifications.*` commands, which also get `PLANESTRO_TITLE` and `PLANESTRO_MESSAGE`. |
| `import-prompts <file> --data <dir> [--commit]` | Legacy, project-specific importer kept as an example (`src/import/legacy/`). Dry-run unless `--commit`; `--copy-small` copies small referenced images in as attachments. |
| `version` | Print the version. `help` (or no command) prints the usage text. |

With no `data_dir`: `PLANESTRO_DATA_DIR`, then a `planestro.yml` in the current directory,
then the most recently used registered project.

| npm script | |
|---|---|
| `npm start -- <data_dir>` | `serve` |
| `npm run dev` / `npm run dev:web` | `serve` under `tsx watch`; Vite on :5173 proxying to :4300 |
| `npm run sample` | `sample` |
| `npm run build` | the web UI into `packages/web/dist` (the server serves it) |
| `npm test`, `npm run typecheck`, `npm run lint` | |
| `npm run spike`, `spike:codex`, `spike:codex-live` | the Agent SDK spike, the Codex spike, the live Codex acceptance runs (these spend real quota) |

Environment: `PLANESTRO_HOME` (where the project registry lives), `PLANESTRO_DATA_DIR`,
`PLANESTRO_DRYRUN_CI=red-once|conflict-once` (make the dry-run world
fail CI once, or conflict once, to watch the recovery paths).
