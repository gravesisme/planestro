# planestro manual

Start with **Getting started** and **Concepts**; the rest is reference.

| | |
|---|---|
| [Getting started](getting-started.md) | Install, the one-minute sample, your first real project. |
| [Concepts](concepts.md) | Items, the lifecycle, parking, epics, dependencies, holds. |
| [Agents](agents.md) | The Claude runner and the Codex runner, their two trust models, models and routing. |
| [The Codex runner](codex-integration.md) | How a Codex turn works, end to end. |
| [Mixed-agent epics](mixed-agent-epics.md) | One feature, art by Codex, code by Claude: breakdown → review → hand-off, as a walkthrough. |
| [Releases](releases.md) | Versions, release notes, store copy with character limits, and the items each one shipped. |
| [Prompts](prompts.md) | The library, placeholders, partials, favorites, templates vs roles. |
| [Configuration](configuration.md) | Every key of `planestro.yml` and `planestro.local.yml`. |
| [CLI](cli.md) | Every command and flag. |
| [Architecture](architecture.md) | Ports, the state machine, the reconciler, the park/resume protocol. |
| [Operations](operations.md) | Watch mode, migrations, recovery, the big red lever, backups. |
| [Troubleshooting](troubleshooting.md) | Every `blocked_reason` and what to do about it. |
| [What planestro sends](what-planestro-sends.md) | Everything that leaves the machine, and who it goes to. There is no telemetry. |

Working documents, not manual pages: the [Codex epic plan](codex-epic-plan.md), the
[going-public checklist](going-public.md), and the spike records under [`notes/`](notes/).
The rules the codebase is held to are in the repository's [`CLAUDE.md`](../CLAUDE.md).
