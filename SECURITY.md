# Security

## Reporting a vulnerability

Use GitHub's private reporting: the repository's **Security** tab → **Report a
vulnerability**. Please don't open a public issue for something exploitable. This is a
personal project maintained by one person, so expect an answer in days, not hours.

Only the latest `main` is supported.

## The trust model: access to the machine is the access control

planestro is a local tool for one developer's own workstation. It has no accounts and
no login. On this machine it needs no token; another device must be paired first (below).
Whoever can use the machine as you can
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
- an `Origin` must be the page's own: the same name *and port* as the `Host` (or a name
  you declared in `allowed_hosts`, for a proxy in front). A page on another `localhost`
  port, such as a dev server or something a worker just built, is another site;
- a request marked `Sec-Fetch-Site: cross-site` is refused, and so is a `same-site` one
  that changes anything;
- a write with a form or `text/plain` body, which browsers send without a CORS preflight,
  is refused. The UI only sends JSON and file uploads.

The UI's page also sends a Content-Security-Policy that loads scripts, images and
connections from planestro alone. Text a model wrote is shown as markdown, and a picture
in it pointing anywhere else is shown as a link, never fetched.

What's left is everything that reaches the port *as this machine*: other processes and
other user accounts on it. **`--host 0.0.0.0` or `lan_access` moves the boundary
outward**, behind two locks. Any bind other than loopback refuses remote addresses outside
loopback, private (RFC 1918), link-local, Tailscale's 100.64.0.0/10 and IPv6 ULA ranges,
so a port-forward gets a 403. And every request not from this machine must carry a
**paired device's token** (#403): `planestro pair` on this machine mints a one-time code
(10 minutes; ten wrong guesses void it), the device trades it at `/pair` for a random
256-bit token kept in an HttpOnly, SameSite=Strict cookie, or sent as `Authorization:
Bearer` by an MCP client. Without one the API, `/ws`, `/mcp` and attachments answer 401.
Only each token's sha256 is stored (in `planestro.local.yml`), and **Revoke** in
Settings → Access ends a device at its next request. Codes are minted only from this
machine. Pairing runs over plain HTTP, so the token is as private as the network it
crosses: use it at home or over a VPN like Tailscale, not on shared Wi-Fi. A paired device
is treated as you. Names you reach it by go in `allowed_hosts` in `planestro.local.yml`.

"This machine" means a loopback peer whose request carries no proxy's forwarding header
(`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`,
`Tailscale-User-Login`, `Tailscale-User-Name`, `Via`). A proxy on this machine that adds one
(Tailscale Serve, nginx, caddy) is treated as another device: it must be paired, and cannot
mint a code or change what runs. **A forward that adds no header looks local:** `ssh -L`,
`socat`, or a reverse proxy configured to strip those headers delivers someone else's request
from 127.0.0.1 with nothing to tell it apart, and planestro answers it as you, unpaired. Never
expose such a forward to anyone but yourself.

From another device you can answer, approve and steer, but not change what runs on this
machine: settings that are commands or programs (setup hooks, the local check, generated
file commands, notification commands, `permissions.allow`, the Claude and Codex binaries,
the code repository's path) and MCP servers are changed only from this machine itself.

## What agents may do

A Claude worker runs under a permission policy: hard rules, your `permissions.allow` /
`deny` / `redirect` (merged from `~/.planestro/policy.yml`, the project and
`planestro.local.yml`, a deny from any layer winning), and optionally the orchestrator's
judgment. Anything the policy doesn't allow parks as a request you answer. It is a guard
rail, not a sandbox: an allowed command runs with your privileges. The worktree-scoped
rules (`…@worktree`) and the pinned working directory read a command's text. They stop a
command that names a path outside the worktree, not a script that writes there once it
runs.

Some things no rule can allow, judged before the SDK's own approvals as well as in the
policy: reading or writing a secret file (SSH, cloud and GitHub CLI logins, `.env`,
keys, a process's `/proc/*/environ`, the Claude and Codex logins), and the git options
that write files or run programs (`--output`, fetch refspecs, `rebase --exec`,
`--upload-pack`, `-c core.*`). A session never inherits `GH_TOKEN` or `GITHUB_TOKEN`.

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
an import files items without queueing them, plans wait for your approval unless you
let the orchestrator approve them (`orchestrator.may_approve_plans`), workers cannot
push, and destructive operations need positive evidence. The orchestrator can still
queue a backlog item for planning, and it reads PR comments, so keep
`orchestrator.may_decide_permissions` off on a public repository.

Outside text reaches a prompt fenced: an `<external source="…">` block that names where
it came from and says, inside it, that it is data to evaluate, never instructions. The
worker and orchestrator rules say the same. That covers an imported issue's title (quoted
on one line) and Description, open pull request titles, `pr_view` and `pr_diff`, and CI
logs. `pr_view` hides the text of comments and reviews by anyone who is not the
repository's owner, a member or a collaborator unless the orchestrator asks for them.
A fence lowers the odds; it does not filter the text. So read an imported issue before
you queue it, and keep `issues.import_label` to a label only maintainers can set.

Workers cannot reach what git runs by itself: the repository's `.git/hooks` and
`.git/config` are on the built-in deny list for every tool, and `git -c` or `git config`
writes that could name a program (`core.hooksPath`, `core.fsmonitor`, a filter, an
alias) are refused. Hooks the project tracks in its own tree (a `.husky/` folder) are
project code, like its tests: a worker that can edit them could already change what
`npm test` runs.

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
Everything else in the data dir (items, plans, prompts, questions, attachments) is committed
to its git repository and pushed to its remote if it has one. Keep that remote private, and
don't paste secrets into items. The journal stays on this machine: it is ignored by git, and
token-shaped strings (GitHub, Anthropic/OpenAI, Slack, AWS keys, bearer headers) are redacted
before a line is written. Nothing is sent anywhere you did not configure: see
[What planestro sends](docs/what-planestro-sends.md).

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
