# Security

## Reporting a vulnerability

Use GitHub's private reporting: the repository's **Security** tab → **Report a
vulnerability**. Please don't open a public issue for something exploitable. This is a
personal project maintained by one person, so expect an answer in days, not hours.

Only the latest `main` is supported.

## What planestro protects, and what it doesn't

planestro is a single-user tool that runs on your own machine. Its agents act **as you**,
with your git, `gh`, Claude and Codex credentials: they edit code, push branches, open and
merge pull requests. Anything that can drive planestro can do those things.

**Who can drive it.** The web UI and its API have no login. The server listens on
`127.0.0.1` by default, so other machines can't reach it. A loopback address still isn't
private from your browser, though: any web page you visit can send requests to
`localhost`. So every request is checked before any route runs, including the WebSocket
upgrade:

- the `Host` must be one of this machine's names, which defeats DNS rebinding;
- a request marked `Sec-Fetch-Site: cross-site`, or with an `Origin` from anywhere else,
  is refused, which defeats cross-site request forgery.

What's left is everything that reaches the port *as this machine*: other processes and
other user accounts on it, and, with `--host 0.0.0.0`, anyone on your network. Only expose
it on a network you trust, or over a private overlay such as Tailscale. Names you reach it
by go in `allowed_hosts` in `planestro.local.yml`.

**Why your Claude login isn't the lock.** Your Claude login decides who pays for and runs
the model. It says nothing about who is sending requests to planestro's port, and there is
no way for a local web app to check a claude.ai identity. An access token for non-loopback
use is planned (see `docs/going-public.md`).

**What agents may do.** A Claude worker runs under a permission policy (hard rules, your
`permissions.allow` / `deny`, and optionally the orchestrator's judgment). It is a guard
rail, not a sandbox: an allowed command runs with your privileges. The worktree-scoped
rules (`…@worktree`) and the pinned working directory read a command's text: they stop a
command that names a path outside the worktree, not a script that writes there once it
runs. A Codex worker runs
inside the Codex CLI's own sandbox (writes confined to its worktree, no network for its
commands). planestro checks its result afterwards.

**Destructive operations** (deleting worktrees and branches) require positive evidence
(a fresh fetch, the PR reported merged, the tip an ancestor of the base). Ambiguity blocks
the item instead of deleting anything.

**Secrets on disk.** `anthropic_api_key`, if you set it, is stored in plain text in
`planestro.local.yml`, which is gitignored and never committed or pushed. Everything
else in the data dir (items, plans, prompts, the journal) is committed to its git
repository and pushed to its remote if it has one. Don't paste secrets into items.
