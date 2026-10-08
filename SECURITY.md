# Security

## Reporting a vulnerability

Use GitHub's private reporting: the repository's **Security** tab → **Report a
vulnerability**. Please don't open a public issue for something exploitable. This is a
personal project maintained by one person, so expect an answer in days, not hours.

Only the latest `main` is supported.

## The trust model: access to the machine is the access control

planestro is a local tool for one developer's own workstation. It has no accounts, no
login and no access token, and none is planned. Whoever can use the machine as you can
drive planestro, just as they could already run `git`, `gh`, `claude` or `codex` in
your terminal. Protect it the way you protect the machine: disk encryption, a screen
lock, and no other people's accounts on it.

Its agents act **as you**, with your git, `gh`, Claude and Codex credentials: they edit
code, push branches, open and merge pull requests. Anything that can drive planestro can
do those things.

**Provider logins.** planestro uses the logins your `claude` and `codex` CLIs already
have on this machine. It has no login of its own and does not ask for a model API key.
Usage is billed to whichever account those CLIs are signed in to. A second login for the
same provider (`accounts` in `planestro.local.yml`) is a separate CLI config directory
on the same machine, never a stored credential. `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX` in the environment planestro starts
in are dropped from every Claude session, so a stray key or cloud switch can't bill
anything but your login. An older `planestro.local.yml` that still holds a key loses it
at startup.

**The port.** The web UI and its API listen on `127.0.0.1` by default, so other machines
can't reach them. A loopback address still isn't private from your browser, though: any
web page you visit can send requests to `localhost`. So every request is checked before
any route runs, including the WebSocket upgrade:

- the `Host` must be one of this machine's names, which defeats DNS rebinding;
- a request marked `Sec-Fetch-Site: cross-site`, or with an `Origin` from anywhere else,
  is refused, which defeats cross-site request forgery.

What's left is everything that reaches the port *as this machine*: other processes and
other user accounts on it. **`--host 0.0.0.0` or `lan_access` moves the boundary
outward:** anyone who can reach the port is treated as you, with no login to stop them.
`lan_access` refuses remote addresses outside loopback, private (RFC 1918), link-local
and IPv6 ULA ranges, so a port-forward gets a 403. It filters addresses; it does not
identify people. Only use it on a network where every device is yours, such as a private
overlay like Tailscale. Names you reach it by go in `allowed_hosts` in
`planestro.local.yml`.

## What agents may do

A Claude worker runs under a permission policy: hard rules, your `permissions.allow` /
`deny` / `redirect` (merged from `~/.planestro/policy.yml`, the project and
`planestro.local.yml`, a deny from any layer winning), and optionally the orchestrator's
judgment. Anything the policy doesn't allow parks as a request you answer. It is a guard
rail, not a sandbox: an allowed command runs with your privileges. The worktree-scoped
rules (`…@worktree`) and the pinned working directory read a command's text. They stop a
command that names a path outside the worktree, not a script that writes there once it
runs.

A Codex worker runs inside the Codex CLI's own sandbox: writes confined to its worktree
(and temp), no network for its commands. Under app-server, a command that needs approval
is recorded and declined at once, and the turn ends for your decision. An approval you
grant is a one-time grant for that exact command. planestro checks the result afterwards.

Neither kind of worker can push or operate on pull requests. Integration is planestro's
job. Two things run outside both policies and deserve the same trust as code you run
yourself:

- the project's `hooks` (for example `after_worktree_create`), run by planestro as you;
- MCP servers you configure in `planestro.local.yml`, started for the models that
  name them.

## Text planestro didn't write is untrusted input

Agents read text that other people can write. On a public code repository, that includes:

- an imported GitHub issue's body, which becomes the item's description and the
  planner's brief;
- PR comments and reviews, which the orchestrator can read;
- CI logs, which feed fix turns, including output quoted from a fork's PR.

Any of these can carry instructions aimed at a model. The defences are structural:
nothing is queued without you, plans wait for your approval, workers cannot push, and
destructive operations need positive evidence. The text itself is not filtered. Read an
imported issue before you queue it. Keep `issues.import_label` to a label only
maintainers can set. Treat review comments from people outside the project as data,
not instructions.

## Data on disk

**Destructive operations** (deleting worktrees and branches) require positive evidence
(a fresh fetch, the PR reported merged, the tip an ancestor of the base). Ambiguity blocks
the item instead of deleting anything.

**Machine-local files.** `planestro.local.yml` (MCP server keys, accounts, machine
settings) and runtime files are excluded from automatic commits, and `planestro.local.yml`
is written with owner-only permissions where supported. Initialization preserves custom
ignore rules while adding the private exclusions. planestro refuses startup or automatic
commits when machine-local settings or runtime files are tracked, and refuses pushes
whose outgoing history includes them. See the
[recovery instructions](docs/troubleshooting.md#machine-local-files-are-tracked).
Everything else in the data dir (items, plans, prompts, the journal) is committed to its
git repository and pushed to its remote if it has one. Keep that remote private, and
don't paste secrets into items.

**Attachments.** Managed attachments are restricted to real files in a known item's
attachment directory; symlinks and traversals are rejected. Active document formats
(such as SVG, HTML and PDF) download instead of running on the control API's origin.
Attachment responses also use a restrictive sandbox policy and disable MIME
sniffing. Treat downloaded files as untrusted when opening them in another program.

**Concurrent Git updates.** A merge is conditioned on the exact verified head SHA.
Cleanup uses conditional ref deletion so a branch that changed after its ancestry
check is kept for inspection; GitHub's merge operation does not delete it early.

**No telemetry.** planestro reports nothing anywhere. Its only outbound traffic is git,
`gh`, the provider CLIs it runs, the MCP servers and notification command you configure,
and other planestro servers on this machine (for the all-projects overview).
