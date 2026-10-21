# Contributing

Thanks for taking a look. planestro is maintained by one person, so the ground rules are about
keeping that sustainable.

- **Issues are welcome**: bugs, rough edges, confusing docs. The bug template asks for what helps.
  Never paste planning data, transcripts or anything with a token in it.
- **Pull requests by prior discussion.** Open an issue first and say what you would change. A PR
  for a change nobody agreed to may sit or be closed, however good it is.
- **Security problems go to private reporting**, never a public issue. See [SECURITY.md](SECURITY.md).

## Branches

- **`develop`** is the default branch: the latest stable code building towards the next release.
  Pull requests target it. A larger piece of work gets its own `feature/<slug>` branch off `develop`,
  with its parts merged into it and one pull request back to `develop`; it is merged forward, never
  rebased or force-pushed.
- **`main`** is the latest release and moves only by a release pull request from `develop`, tagged
  `vX.Y.Z` with release notes. Installing from `main` (`git clone --branch main`) gets the latest
  release, and so does auto-update: it moves a planestro clone to the newest `main` commit whose CI
  passed.
- **A hotfix** to a release goes `main` → `hotfix/<slug>` → a pull request into `main` and a patch
  tag, then `main` is merged into `develop` so the fix is not lost.

## Working on it

```sh
nvm use            # Node 24 (.nvmrc)
npm install
npm run typecheck
npm run lint       # eslint: floating promises, unused code, new `any`s, rules of hooks
npm test           # vitest; real git in temp dirs, never the network, GitHub or a model
npm run build
npm run sample     # the no-credentials demo
```

A change is reviewed against the design invariants in [CLAUDE.md](CLAUDE.md): who owns state, no
waits on a person, destructive operations only on positive evidence, nothing project-specific.
Every fix comes with a test that fails without it. The engine's lifecycle code never names a branch
literally (a test checks).

`npm run lint` is type-aware and deliberately small (`eslint.config.js`). A promise nobody waits on
gets `await`, or `void` plus a `.catch` that logs when it can fail. The `any`s already in `src` are
grandfathered in `eslint-suppressions.json`: removing one makes lint ask you to run
`npx eslint . --prune-suppressions`; a new one fails unless you type it. A suppression of anything
else is an `eslint-disable-next-line` with its reason.

`CLAUDE.md` and `AGENTS.md` are one document for two agents and must stay byte-identical: edit one
and copy it over the other (a test checks this too). A schema change goes through
`packages/server/src/migrations` and bumps `SCHEMA_VERSION`.

### Testing the web UI

Logic that can live in a plain module (`packages/web/src/*.ts`) is tested there, without a DOM. What
only shows when a component renders (a badge that follows the stream, a board that must not redraw,
a click that opens a zoom) goes in a DOM test: a `packages/web/test/**/*.dom.test.tsx` file runs
under jsdom with Testing Library, and every other test file stays in Node. Start from
`packages/web/test/dom/fixture.tsx`:

- `item(id, frontmatter?, derived?)` and `state(items, { sessions?, mode? })` build what `/api/state`
  sends, through the real schemas;
- `mockApi({ '/api/state': () => s, … })` answers `fetch` from a table (anything else is a 404) and
  counts the requests;
- `installSocket()` replaces `WebSocket`: after `useStore.getState().connect()`,
  `FakeSocket.last.open()` connects and `FakeSocket.last.emit(event)` is the server sending one.

```tsx
it("shows a running agent's last output", () => {
  const tp1 = item('TP-1', { status: 'IN_PROGRESS' });
  useStore.setState({ state: state([tp1], { sessions: [{ item: 'TP-1', op: 'implement', busy: true }] }) });
  render(<MemoryRouter><ItemCard item={tp1} /></MemoryRouter>);
  act(() => useStore.setState({ lastOutput: { 'TP-1': 'Running npm test' } }));
  expect(screen.getByRole('button', { name: 'implementing…' }).title).toBe('Last output: Running npm test');
});
```

Query by role and text, as a person finds things, before reaching for class names. Wrap anything that
changes the store in `act`, and use fake timers (`vi.useFakeTimers()`, `vi.runAllTimersAsync()`)
where the store throttles. `npx vitest run --project dom` runs only these.

Commit messages say what changed for the user, in a sentence, with the issue number: `A merged
child's worktree is removed only once its branch is on the base (#123)`.

By contributing you agree that your contribution is licensed under the MIT licence.
