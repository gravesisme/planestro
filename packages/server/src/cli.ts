#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { SCHEMA_VERSION } from '@planestro/shared';
import { DataStore } from './store/DataStore.ts';
import { initDataDir, layoutRefusal } from './init.ts';
import { migrate } from './migrations/index.ts';
import { locateDataDir, readLocalConfig, TOOL_VERSION, CONFIG_FILE } from './config.ts';
import { bindHost } from './guard.ts';
import { exitCodeFor } from './exitCodes.ts';
import { desktopNotify } from './notifier.ts';

const USAGE = `planestro ${TOOL_VERSION}

  planestro init <data_dir> --repo <code_repo> [--name N] [--prefix HH] [--default-branch B] [--release-branch B] [--github owner/repo] [--no-commit]
  planestro check [data_dir]        validate every file and report
  planestro check [data_dir] --preflight [--offline] [--port N] [--json]
                                    what a first task would stop on, found on this machine with no model call (#337): Node,
                                    git and its identity, the code repo's HEAD, remote and base branch, gh sign-in, the
                                    claude / codex CLIs the models use and their sign-in, named accounts, the planning repo,
                                    the port, a worktree setup hook. Each problem with its repair; --offline skips the network
  planestro migrate [data_dir]      apply schema migrations (${SCHEMA_VERSION} is current)
  planestro serve [data_dir] [--port N] [--host H] [--mock] [--watch] [--open]
                                    run the web UI + engine (default host 127.0.0.1, or 0.0.0.0 with lan_access in planestro.local.yml)
                                    --watch  restart on planestro source changes (between agent turns) and rebuild the UI
                                    --open   open the UI in a browser once it is up
  planestro start [data_dir] [--port N] [--host H] [--watch]
                                    run serve in the background, in a session of its own (it outlives this terminal and a
                                    Claude Code task's time cap); returns once it answers, then reconciles and prints the corrections.
                                    Already running there: prints it and exits 0. Refuses a data dir or port held by anything else.
                                    Log: <data_dir>/.planestro/serve.log
  planestro stop [data_dir] | --port N | --all
                                    stop that server's whole process group (SIGTERM, SIGKILL after 15 s); with no argument, the
                                    data dir in this directory. Never stops anything it cannot identify as the server asked for
  planestro status [data_dir] [--json]
                                    every running instance on this machine: data dir, URL, pid / process group, uptime, log;
                                    --json for scripts (one record, or null with exit 3, when a data dir is given)
  planestro sample [dir] [--reset] [--no-serve] [--port N]
                                    build a fictional project with a full backlog and serve it in dry-run:
                                    no repo, GitHub remote or Claude login needed (default dir .planestro/sample, port 4310)
  planestro permissions suggest [data_dir] [--json] [--min N]
                                    allow rules suggested from past permission rulings (#169): safe kinds of command the
                                    orchestrator and the user keep approving, each replayed against every past ruling so
                                    none would have allowed anything ever denied; also kinds of command denied every time
                                    and drift (rules nothing ran under, approvals rising) (#203). Read-only: add the ones you accept in Settings
  planestro import issues [data_dir] [N ...] [--label L] [--closes] [--port N]
                                    file GitHub issues of code_repo.github as items, unsubmitted (#231): the numbers given,
                                    or every open issue with --label (default issues.import_label). One already imported is
                                    skipped. --closes: their PRs say "Closes #N". Goes through the running server when there is one
                                    (one started with serve rather than start: name its --port)
  planestro notify <title> <message>
                                    show a desktop notification (osascript on a Mac, notify-send on Linux); for notifications.* commands,
                                    which also get PLANESTRO_TITLE and PLANESTRO_MESSAGE
  planestro version
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' }, name: { type: 'string' }, prefix: { type: 'string' }, 'default-branch': { type: 'string' },
    'release-branch': { type: 'string' }, github: { type: 'string' }, layout: { type: 'string' }, 'no-commit': { type: 'boolean' },
    commit: { type: 'boolean' }, 'copy-small': { type: 'boolean' }, data: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, port: { type: 'string' }, host: { type: 'string' }, mock: { type: 'boolean' }, watch: { type: 'boolean' }, open: { type: 'boolean' }, reset: { type: 'boolean' }, 'no-serve': { type: 'boolean' }, all: { type: 'boolean' }, json: { type: 'boolean' }, min: { type: 'string' }, label: { type: 'string' }, closes: { type: 'boolean' }, preflight: { type: 'boolean' }, offline: { type: 'boolean' },
  },
});
const [cmd, arg] = positionals;
const log = (m: string) => console.log(m);

try {
  switch (cmd) {
    case 'init': {
      if (!arg || !values.repo) throw new Error('usage: planestro init <data_dir> --repo <code_repo>');
      const withdrawn = layoutRefusal(values.layout); if (withdrawn) throw new Error(withdrawn);
      const { created } = initDataDir({
        dataDir: arg, codeRepo: values.repo, name: values.name, prefix: values.prefix, defaultBranch: values['default-branch'],
        releaseBranch: values['release-branch'], github: values.github,
        commit: !values['no-commit'], log,
      });
      log(`initialized ${resolve(arg)} (${created.length} files created)`);
      break;
    }
    case 'check': {
      const dir = locateDataDir(arg);
      if (values.preflight) {
        // Read-only, and no store: a data dir that is not a git repository yet is one of the things it reports.
        const { preflight, liveEnv, runnersInUse, accountsOf, savePreflight, formatPreflight } = await import('./preflight.ts');
        const { readConfig, resolveCodeRepo } = await import('./config.ts');
        const { readInstance, groupAlive } = await import('./instances.ts');
        const config = readConfig(dir); const local = readLocalConfig(dir);
        const port = values.port ? Number(values.port) : 4300;
        const own = readInstance(dir);
        const r = await preflight({
          dataDir: dir, codeRepo: resolveCodeRepo(dir, config, local), defaultBranch: config.code_repo.default_branch, github: config.code_repo.github,
          runners: runnersInUse(config, []), accounts: accountsOf(local), claudeBin: local.claude_bin && local.claude_bin !== 'bundled' ? local.claude_bin : undefined, codexBin: local.codex_bin,
          port, host: bindHost(values.host, local), ownServerOnPort: Boolean(own && own.port === port && groupAlive(own.pgid)),
          afterWorktreeCreate: config.hooks.after_worktree_create, offline: values.offline,
        }, liveEnv);
        savePreflight(dir, r);
        if (values.json) log(JSON.stringify(r, null, 2));
        else { log(`preflight: ${dir}`); for (const line of formatPreflight(r)) log(line); }
        if (!r.ok) process.exit(1);
        break;
      }
      const store = await DataStore.open(dir, { lock: false, log: (l, m) => log(`[${l}] ${m}`) });
      const s = store.stats();
      log(`${dir}: schema ${store.config.schema_version} (${store.schema}), ${s.items} items, ${s.prompts} prompts, ${s.releases} releases, ${s.invalid} invalid`);
      for (const inv of store.invalid) log(`  INVALID ${inv.path}: ${inv.error}`);
      for (const item of store.listItems()) {
        const d = store.derived(item);
        if (d.base_branch_error) log(`  WARN ${item.id}: ${d.base_branch_error}`);
      }
      const { accessReport } = await import('./server.ts');
      for (const line of accessReport(store.local, store.config.notifications, values.port ? Number(values.port) : 4300)) log(line);
      store.close();
      if (store.invalid.length) process.exit(1);
      break;
    }
    case 'migrate': {
      const dir = locateDataDir(arg);
      const r = await migrate(dir, log);
      log(`schema ${r.from} → ${r.to}${r.applied.length ? ` (applied ${r.applied.join(', ')})` : ' (nothing to do)'}`);
      break;
    }
    case 'import-prompts': {
      if (!arg) throw new Error('usage: planestro import-prompts <file> [--data <dir>] [--commit]');
      const dir = locateDataDir(values.data);
      const store = await DataStore.open(dir, { log: (l, m) => log(`[${l}] ${m}`) });
      const { importPrompts } = await import('./import/legacy/handMaintainedPrompts.ts');
      const r = importPrompts(store, resolve(arg), { commit: Boolean(values.commit), copySmall: Boolean(values['copy-small']) });
      for (const row of r.rows) log(`${row.kind.padEnd(7)} ${(row.id ?? row.name ?? '').padEnd(8)} ${(row.status ?? '').padEnd(18)} ${(row.category ?? '').padEnd(16)} ${row.title.slice(0, 70)}${row.flags.length ? '  [' + row.flags.join('; ') + ']' : ''}`);
      log(`${values.commit ? 'imported' : 'would import'}: ${r.items} items, ${r.prompts} prompts (${r.skipped} skipped)${values.commit ? '' : ' — re-run with --commit to write'}`);
      await store.flushCommits(); store.close();
      break;
    }
    case 'reconcile': {
      const dir = locateDataDir(arg);
      const { DataStore: DS } = await import('./store/DataStore.ts');
      const { LiveEngine } = await import('./engine/LiveEngine.ts');
      const { makePorts } = await import('./engine/makePorts.ts');
      const store = await DS.open(dir, { log: (l, m) => log(`[${l}] ${m}`) });
      const engine = new LiveEngine(store, makePorts('live', (m) => log(m), store), () => {}, {});
      const corrections = await engine.reconcile('manual');
      for (const cx of corrections) log(`  ${cx}`);
      log(corrections.length ? `${corrections.length} correction(s) applied` : 'everything matches');
      await store.flushCommits(); store.git.checkpoint(); await store.git.push(); store.close();
      break;
    }
    case 'serve': {
      const dir = locateDataDir(arg);
      // lan_access is re-read by every serve the supervisor restarts: only an explicit --host is passed down (#255).
      const host = bindHost(values.host, readLocalConfig(dir)); const port = values.port ? Number(values.port) : 4300;
      if (values.watch) {
        const { supervise } = await import('./supervise.ts');
        await supervise({ dataDir: dir, serveArgs: [dir, ...(values.port ? ['--port', values.port] : []), ...(values.host ? ['--host', values.host] : []), ...(values.mock ? ['--mock'] : [])], host, hostFlag: values.host, port, open: values.open });
        break;
      }
      if (values.open) void import('./supervise.ts').then((m) => m.openWhenUp(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, log));
      const { startServer } = await import('./server.ts');
      // Under `serve --watch`, the supervisor's socket (#354); otherwise, or from an older supervisor, bind as before.
      const listen = await (await import('./portHandoff.ts')).receivePort();
      await startServer({ dataDir: dir, port: values.port ? Number(values.port) : undefined, host: values.host, mock: values.mock, listen });
      break;
    }
    case 'start': {
      const { startInstance, uptime } = await import('./instances.ts');
      const dir = locateDataDir(arg);
      const port = values.port ? Number(values.port) : 4300;
      if (!Number.isInteger(port) || port <= 0) throw new Error(`--port ${values.port} is not a port number`);
      log(`starting planestro for ${dir} on port ${port}…`);
      const r = await startInstance({ dataDir: dir, port, host: values.host, watch: values.watch, log });
      const i = r.instance;
      if (r.already) { log(`already running: ${i.url}${i.host === '0.0.0.0' ? ' (listening on 0.0.0.0)' : ''}  pid ${i.pid}, process group ${i.pgid}${i.watch ? ', --watch' : ''}, up ${uptime(i.started_at)}\nlog: ${i.log}`); break; }
      if (r.clearedLock) log(`removed a stale data-dir lock: its pid ${r.clearedLock.pid} now runs something else (${r.clearedLock.command})`);
      log(`up: ${i.url}${i.host === '0.0.0.0' ? ' (listening on 0.0.0.0)' : ''}  pid ${i.pid}, process group ${i.pgid}${i.watch ? ', --watch' : ''}`);
      log(`log: ${i.log}`);
      log(`operator MCP: ${i.url}/mcp`);
      if (r.corrections) { log(`reconcile: ${r.corrections.length ? `${r.corrections.length} correction(s)` : 'everything matches'}`); for (const cx of r.corrections) log(`  ${cx}`); }
      else log(`reconcile failed: ${r.reconcileError} (the server is up; reconcile from the UI or POST ${i.url}/api/reconcile)`);
      log(`stop it with: planestro stop ${i.data_dir}`);
      break;
    }
    case 'stop': {
      const { liveInstance, listInstances, stopInstance, stopUnrecorded, unrecordedHolder, portListener } = await import('./instances.ts');
      const said = (how: string, what: string) => log(`${how === 'killed' ? 'stopped (SIGKILL after the grace period)' : how === 'not_running' ? 'was already gone' : 'stopped'}: ${what}`);
      if (values.all) {
        const { live } = listInstances();
        if (!live.length) { log('no recorded planestro instance is running'); break; }
        for (const r of live) said(await stopInstance(r, { log }), `${r.data_dir} (${r.url}, process group ${r.pgid})`);
        break;
      }
      if (values.port) {
        const port = Number(values.port);
        const rec = listInstances().live.find((r) => r.port === port);
        if (rec) { said(await stopInstance(rec, { log }), `${rec.data_dir} (${rec.url}, process group ${rec.pgid})`); break; }
        const pid = portListener(port);
        if (!pid) { log(`nothing is listening on port ${port}`); break; }
        const r = await stopUnrecorded(pid, { log });
        if ('refused' in r) throw new Error(`port ${port}: ${r.refused}`);
        log(`stopped: pid ${r.pid} on port ${port}, started outside \`planestro start\` (${r.command})`);
        break;
      }
      // No argument: only the data dir this directory names. Guessing among several servers is how a neighbour gets stopped.
      const dir = arg ? resolve(arg) : process.env.PLANESTRO_DATA_DIR ? resolve(process.env.PLANESTRO_DATA_DIR) : existsSync(join(process.cwd(), CONFIG_FILE)) ? process.cwd() : undefined;
      if (!dir) {
        const { live } = listInstances();
        throw new Error(`no data dir here; say which server to stop: planestro stop <data_dir> | --port N | --all${live.length ? `\nrunning:\n${live.map((r) => `  ${r.data_dir}  ${r.url}`).join('\n')}` : ''}`);
      }
      const rec = liveInstance(dir);
      if (rec) { said(await stopInstance(rec, { log }), `${dir} (${rec.url}, process group ${rec.pgid})`); break; }
      const holder = unrecordedHolder(dir);
      if (!holder) { log(`not running: ${dir}`); break; }
      const r = await stopUnrecorded(holder, { log });
      if ('refused' in r) throw new Error(r.refused);
      log(`stopped: ${dir}, pid ${r.pid}, started outside \`planestro start\` (${r.command})`);
      break;
    }
    case 'status': {
      const { listInstances, liveInstance, describeInstance } = await import('./instances.ts');
      if (arg) {
        const r = liveInstance(resolve(arg));
        log(values.json ? JSON.stringify(r ? { ...r, mcp: `${r.url}/mcp` } : null) : r ? describeInstance(r) : `not running: ${resolve(arg)}`);
        if (!r) process.exitCode = 3;
        break;
      }
      const { live, pruned } = listInstances();
      if (values.json) { log(JSON.stringify(live.map((r) => ({ ...r, mcp: `${r.url}/mcp` })))); break; }
      for (const d of pruned) log(`(pruned a stale record: ${d})`);
      log(live.length ? live.map(describeInstance).join('\n') : 'no planestro instance is running (servers started with `serve` instead of `start` are not listed)');
      break;
    }
    case 'sample': {
      const { seedSample } = await import('./sample.ts');
      const r = await seedSample(arg ?? '.planestro/sample', { reset: values.reset, log });
      log(`sample project: ${r.codeRepo}\nplanning data:  ${r.dataDir}${r.items ? ` (${r.items} items seeded)` : ''}`);
      if (values['no-serve']) { log(`serve it with: planestro serve ${r.dataDir} --port 4310`); break; }
      const port = values.port ? Number(values.port) : 4310;
      log('dry-run engine: queue an item and watch it go plan → approval → PR → CI → merge with fake git, GitHub and agent');
      const { openWhenUp } = await import('./supervise.ts');
      void openWhenUp(`http://127.0.0.1:${port}`, log);
      const { startServer } = await import('./server.ts');
      await startServer({ dataDir: r.dataDir, port, host: values.host });
      break;
    }
    case 'permissions': {
      if (arg !== 'suggest') throw new Error('usage: planestro permissions suggest [data_dir] [--json] [--min N]');
      const dir = locateDataDir(positionals[2]);
      const store = await DataStore.open(dir, { lock: false, log: () => {} });
      const { suggestForStore, formatSuggestReport } = await import('./engine/allowSuggest.ts');
      const report = suggestForStore(store, { minApprovals: values.min ? Number(values.min) : undefined });
      store.close();
      log(values.json ? JSON.stringify(report, null, 2) : formatSuggestReport(report));
      break;
    }
    case 'import': {
      if (arg !== 'issues') throw new Error('usage: planestro import issues [data_dir] [N ...] [--label L] [--closes]');
      const rest = positionals.slice(2);
      const issues = rest.filter((p) => /^#?\d+$/.test(p)).map((p) => Number(p.replace('#', '')));
      const dir = locateDataDir(rest.find((p) => !/^#?\d+$/.test(p)));
      const body = { ...(issues.length ? { issues } : {}), ...(values.label ? { label: values.label } : {}), ...(values.closes ? { closes: true } : {}) };
      const { liveInstance } = await import('./instances.ts');
      // A server `start` recorded is found; one run with `serve` is named by --port.
      const server = liveInstance(dir)?.url ?? (values.port ? `http://127.0.0.1:${values.port}` : undefined);
      let r: import('./engine/issueImport.ts').ImportResult;
      if (server) {
        // While planestro runs it is the only writer of the data dir (invariant 1): the server files the items.
        const res = await fetch(`${server}/api/issues/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json() as any;
        if (!res.ok) throw new Error(json.error ?? `the server answered ${res.status}`);
        r = json;
      } else {
        const store = await DataStore.open(dir, { log: () => {} });
        try {
          const { makePorts } = await import('./engine/makePorts.ts');
          const { importIssues } = await import('./engine/issueImport.ts');
          r = await importIssues(store, makePorts(store.config.engine.mode, log, store).gh, body);
          await store.flushCommits();
        } finally { store.close(); }
      }
      for (const x of r.imported) log(`imported #${x.issue} as ${x.item}: ${x.title}`);
      for (const x of r.skipped) log(`skipped  #${x.issue}: ${x.reason}`);
      log(`${r.imported.length} imported from ${r.repo}, ${r.skipped.length} skipped${r.imported.length ? ' (not submitted: queue them when you want them worked on)' : ''}`);
      break;
    }
    case 'notify': {
      const [, title, ...rest] = positionals;
      if (!title) { log(USAGE); process.exit(1); }
      log(`notified via ${await desktopNotify(title, rest.join(' '))}`);
      break;
    }
    case 'version': log(TOOL_VERSION); break;
    default: log(USAGE); process.exit(cmd && cmd !== 'help' ? 1 : 0);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  if (e instanceof Error && 'exitCode' in e && typeof e.exitCode === 'number') process.exit(e.exitCode);
  // A data dir or port someone else holds gets its own code: `serve --watch` stops on it (#85).
  process.exit(exitCodeFor(e));
}
