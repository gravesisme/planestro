# Contributing

Thanks for taking a look. planestro is maintained by one person, so the ground rules are about
keeping that sustainable.

- **Issues are welcome**: bugs, rough edges, confusing docs. The bug template asks for what helps.
  Never paste planning data, transcripts or anything with a token in it.
- **Pull requests by prior discussion.** Open an issue first and say what you would change. A PR
  for a change nobody agreed to may sit or be closed, however good it is.
- **Security problems go to private reporting**, never a public issue. See [SECURITY.md](SECURITY.md).

## Working on it

```sh
nvm use            # Node 24 (.nvmrc)
npm install
npm run typecheck
npm test           # vitest; real git in temp dirs, never the network, GitHub or a model
npm run build
npm run sample     # the no-credentials demo
```

A change is reviewed against the design invariants in [CLAUDE.md](CLAUDE.md): who owns state, no
waits on a person, destructive operations only on positive evidence, nothing project-specific.
Every fix comes with a test that fails without it. The engine's lifecycle code never names a branch
literally (a test checks).

`CLAUDE.md` and `AGENTS.md` are one document for two agents and must stay byte-identical: edit one
and copy it over the other (a test checks this too). A schema change goes through
`packages/server/src/migrations` and bumps `SCHEMA_VERSION`.

Commit messages say what changed for the user, in a sentence, with the issue number: `A merged
child's worktree is removed only once its branch is on the base (#123)`.

By contributing you agree that your contribution is licensed under the MIT licence.
