import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isoLocal } from '@planestro/shared';
import { DataStore, type ItemOp } from './store/DataStore.ts';
import { initDataDir } from './init.ts';

/**
 * `planestro sample`: a fictional project with a populated backlog, so the whole tool can be seen
 * without a real repo, a GitHub remote or a Claude login. The engine stays in dry-run: git, GitHub
 * and the agent are the in-memory fakes the test suite drives, which carry an item all the way from
 * QUEUED to FINISHED. Nothing here talks to the network.
 */
export interface SampleResult { root: string; codeRepo: string; dataDir: string; items: number }

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=planestro sample', '-c', 'user.email=sample@planestro.invalid', ...args], { stdio: 'pipe' });
const hasGitIdentity = () => { try { return execFileSync('git', ['config', 'user.email'], { stdio: 'pipe' }).toString().trim() !== ''; } catch { return false; } };
const daysAgo = (d: number, h = 10, m = 0) => { const t = new Date(); t.setDate(t.getDate() - d); t.setHours(h, m, 0, 0); return t; };

const CODE: Record<string, string> = {
  'README.md': '# tidepool\n\nTide times for the beach you are standing on, from the command line.\n\n```sh\ntidepool today --station 9414290\n```\n',
  'package.json': JSON.stringify({ name: 'tidepool', version: '0.3.0', type: 'module', bin: { tidepool: 'src/cli.js' }, scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/cli.js': "#!/usr/bin/env node\nimport { today } from './tides.js';\n\nconst station = process.argv[process.argv.indexOf('--station') + 1];\nconsole.log(await today(station));\n",
  'src/tides.js': "const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';\n\nexport async function today(station) {\n  const url = `${API}?product=predictions&station=${station}&date=today&datum=MLLW&units=english&time_zone=lst_ldt&interval=hilo&format=json`;\n  const { predictions } = await (await fetch(url)).json();\n  return predictions.map((p) => `${p.t}  ${p.type === 'H' ? 'high' : 'low '}  ${p.v} ft`).join('\\n');\n}\n",
};

interface Seed {
  key: string; title: string; category: string; description: string; notes?: string;
  kind?: 'item' | 'epic'; parent?: string; depends_on?: string[]; icebox?: boolean;
  /** A finished item: how many days ago it merged, its PR number and the plan it was approved with. */
  done?: { daysAgo: number; pr: number; plan: string; ciRedOnce?: boolean };
}

const SEEDS: Seed[] = [
  { key: 'json', title: 'Add a --json flag for scripting', category: 'Feature', done: { daysAgo: 9, pr: 12, plan: '1. Thread an `output` option from `cli.js` into `today()`.\n2. Return the prediction objects untouched when it is `json`.\n3. Cover both shapes in `test/tides.test.js`.' },
    description: 'People pipe `tidepool today` into other tools and then parse the aligned columns back apart.\n\nAdd `--json`, printing the predictions as an array of `{ time, type, feet }`. The human format stays the default.' },
  { key: 'station-error', title: 'Unknown station id prints a stack trace', category: 'Bug', done: { daysAgo: 6, pr: 14, ciRedOnce: true, plan: '1. NOAA answers 200 with an `error` object for a bad station; check for it before reading `predictions`.\n2. Exit 2 with a one-line message naming the station.\n3. Regression test with a recorded error response.' },
    description: '`tidepool today --station 0000000` dies with `TypeError: Cannot read properties of undefined (reading \'map\')`.\n\nIt should say the station is unknown and exit non-zero.' },
  { key: 'node-version', title: 'Declare the supported Node range', category: 'Chore', done: { daysAgo: 2, pr: 15, plan: '1. Add `engines.node >= 20` to `package.json` (global `fetch`).\n2. Say so in the README.' },
    description: 'The CLI relies on global `fetch`. Declare `engines` so an old Node fails at install instead of at the first request.' },

  { key: 'nearest', title: 'Find the nearest station from a lat/long', category: 'Feature',
    description: 'Nobody knows their NOAA station id. Accept `--near 37.80,-122.46` and pick the closest station that publishes predictions.\n\n- The station list is one request; cache it on disk for a week.\n- Print which station was chosen, so the answer can be checked.\n- Out of scope: geocoding a place name.' },
  { key: 'week', title: '`tidepool week`: seven days at a glance', category: 'Feature',
    description: 'A `week` command showing each day\'s highs and lows on one line, today first. Mark the lowest low of the week: that is the tide-pooling day.' },
  { key: 'timezone', title: 'Times are wrong for a station in another time zone', category: 'Bug',
    description: 'Asking for a Hawaii station from California prints California times. The request uses `lst_ldt` (the station\'s local time) but the output is re-parsed with `new Date()` in one path.\n\nFind the path, keep station-local time end to end, and label the zone in the header.',
    notes: 'Reproduced with station 1612340 (Honolulu). `today` is right; the new `--json` path is the one that re-parses.' },
  { key: 'readme', title: 'README: install and first-run section', category: 'Docs',
    description: 'The README shows one command and nothing about installing. Add install (npm and npx), a first run with a real station, and the three most useful flags.' },

  { key: 'offline', title: 'Offline mode', category: 'Feature', kind: 'epic',
    description: 'Tide predictions are deterministic and published a year ahead. Once a station has been fetched, the CLI should answer without a network.\n\nChildren land on the epic\'s integration branch and ship together.' },
  { key: 'cache', title: 'Cache a station\'s yearly predictions on disk', category: 'Feature', parent: 'offline',
    description: 'On first use of a station, fetch the full year and store it under the XDG cache dir. Every later command reads the cache first.\n\n- One file per station and year.\n- `tidepool cache clear` removes them.' },
  { key: 'offline-flag', title: 'Answer from cache with no network, and say so', category: 'Feature', parent: 'offline', depends_on: ['cache'],
    description: 'With the cache in place: when the request fails and the station is cached, answer from the cache and print `(offline: cached 2026-01-04)` on stderr. `--offline` skips the request entirely.' },

  { key: 'moon', title: 'Moon phase next to each day', category: 'Feature', icebox: true,
    description: 'Spring tides follow the new and full moon. A phase glyph per day in `week` would explain the big swings. Nice, not needed.' },
  { key: 'gui', title: 'Menu-bar app', category: 'Feature', icebox: true,
    description: 'A tiny macOS menu-bar app showing the next tide. A different project, really — parked until the CLI is boring.' },
];

/** The Activity log of an item that went the whole way, with plausible gaps between the steps. */
function history(id: string, s: Required<Pick<Seed, 'done'>>['done'], title: string): { body: string; stamps: Record<string, string> } {
  const at = (h: number, m: number) => isoLocal(daysAgo(s.daysAgo, h, m));
  const created = isoLocal(daysAgo(s.daysAgo + 3, 16, 12));
  const branch = `td/${id.split('-')[1]}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
  const lines: [string, string, string][] = [
    [created, 'user', 'created'],
    [at(9, 2), 'user', 'status NOT_YET_SUBMITTED → QUEUED'],
    [at(9, 2), 'app', `creating worktree .claude/worktrees/${branch.replace('/', '-')} on ${branch} from origin/main`],
    [at(9, 9), 'app', 'status PLAN_IN_PROGRESS → PLAN_READY'],
    [at(9, 31), 'user', 'status PLAN_READY → IN_PROGRESS'],
    [at(9, 48), 'worker', `done: ${title} — implemented as planned, tests added, suite green locally.`],
    [at(9, 49), 'app', `opened PR #${s.pr}`],
    [at(9, 49), 'app', 'waiting for CI'],
    ...(s.ciRedOnce ? [
      [at(9, 56), 'app', 'CI red (github, attempt 1): test/tides.test.js › unknown station — expected exit code 2, got 1'],
      [at(10, 4), 'app', 'session updated the branch; re-entering the merge pipeline'],
    ] as [string, string, string][] : []),
    [at(10, 14), 'app', `merged PR #${s.pr}`],
    [at(10, 14), 'app', `removed worktree and branch ${branch} (local + remote)`],
  ];
  return {
    body: lines.map(([when, actor, text]) => `- ${when} [${actor}] ${text}`).join('\n'),
    stamps: { created_at: created, queued_at: at(9, 2), started_at: at(9, 2), plan_ready_at: at(9, 9), plan_approved_at: at(9, 31), pr_created_at: at(9, 49), merged_at: at(10, 14), finished_at: at(10, 14) },
  };
}

export async function seedSample(out: string, opts: { reset?: boolean; log?: (m: string) => void } = {}): Promise<SampleResult> {
  const log = opts.log ?? (() => {});
  const root = resolve(out);
  const codeRepo = join(root, 'tidepool');
  const dataDir = join(root, 'tidepool-planning');
  if (existsSync(join(dataDir, 'planestro.yml'))) {
    if (!opts.reset) { log(`sample already exists at ${root} (use --reset to rebuild it)`); return { root, codeRepo, dataDir, items: 0 }; }
    rmSync(root, { recursive: true, force: true });
  }

  mkdirSync(join(codeRepo, 'src'), { recursive: true });
  for (const [rel, text] of Object.entries(CODE)) writeFileSync(join(codeRepo, rel), text);
  git(codeRepo, 'init', '-q', '-b', 'main');
  git(codeRepo, 'add', '-A');
  git(codeRepo, 'commit', '-q', '-m', 'tidepool 0.3.0');

  mkdirSync(dataDir, { recursive: true });
  git(dataDir, 'init', '-q', '-b', 'planning');
  // planestro commits to the data dir as whoever runs it; a machine with no git identity (a fresh
  // laptop, a CI runner) still has to be able to run the demo, so give these two repos a local one.
  if (!hasGitIdentity()) for (const repo of [codeRepo, dataDir]) { git(repo, 'config', 'user.name', 'planestro sample'); git(repo, 'config', 'user.email', 'sample@planestro.invalid'); }
  initDataDir({ dataDir, codeRepo, name: 'tidepool (sample)', prefix: 'TD', defaultBranch: 'main', github: 'example/tidepool', gdignore: false, register: false, commit: true });

  // The seed writes through the store like any other client, so it can never produce a file the tool would reject.
  const store = await DataStore.open(dataDir);
  try {
    const ids = new Map<string, string>();
    for (const s of SEEDS) {
      const item = store.createItem({
        title: s.title, category: s.category, description: s.description, notes: s.notes, kind: s.kind,
        parent: s.parent ? ids.get(s.parent) : undefined, depends_on: s.depends_on?.map((k) => ids.get(k)!),
        status: s.icebox ? 'ICEBOX' : undefined,
      });
      ids.set(s.key, item.id);
      if (!s.done) continue;
      const h = history(item.id, s.done, s.title);
      const ops: ItemOp[] = [
        { set: { status: 'FINISHED', pr: s.done.pr, ci_result: 'green', ci_failed_count: s.done.ciRedOnce ? 1 : 0, ...h.stamps } },
        { section: 'Plan', body: s.done.plan },
        { section: 'Activity', body: h.body },
      ];
      store.mutateItem(item.id, ops, 'user');
    }
    await store.flushCommits();
    store.git.commit('sample: seed the tidepool backlog');
    await store.flushCommits();
    return { root, codeRepo, dataDir, items: SEEDS.length };
  } finally { store.close(); }
}
