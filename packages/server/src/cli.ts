#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { SCHEMA_VERSION } from '@planestro/shared';
import { DataStore } from './store/DataStore.ts';
import { initDataDir } from './init.ts';
import { migrate } from './migrations/index.ts';
import { locateDataDir, TOOL_VERSION, CONFIG_FILE } from './config.ts';
import { exitCodeFor } from './exitCodes.ts';
import { desktopNotify } from './notifier.ts';

const USAGE = `planestro ${TOOL_VERSION}

  planestro init <data_dir> --repo <code_repo> [--name N] [--prefix HH] [--default-branch B] [--release-branch B] [--github owner/repo] [--layout dir|orphan-branch] [--no-commit]
  planestro check [data_dir]        validate every file and report
  planestro migrate [data_dir]      apply schema migrations (${SCHEMA_VERSION} is current)
  planestro serve [data_dir] [--port N] [--host H] [--mock] [--watch] [--open]
                                    run the web UI + engine (default host 127.0.0.1; use 0.0.0.0 for LAN access)
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
  planestro status [data_dir]       every running instance on this machine: data dir, URL, pid / process group, uptime, log
  planestro sample [dir] [--reset] [--no-serve] [--port N]
                                    build a fictional project with a full backlog and serve it in dry-run:
                                    no repo, GitHub remote or Claude login needed (default dir .planestro/sample, port 4310)
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
    help: { type: 'boolean', short: 'h' }, port: { type: 'string' }, host: { type: 'string' }, mock: { type: 'boolean' }, watch: { type: 'boolean' }, open: { type: 'boolean' }, reset: { type: 'boolean' }, 'no-serve': { type: 'boolean' }, all: { type: 'boolean' },
  },
});
const [cmd, arg] = positionals;
const log = (m: string) => console.log(m);

try {
  switch (cmd) {
    case 'init': {
      if (!arg || !values.repo) throw new Error('usage: planestro init <data_dir> --repo <code_repo>');
      const { created } = initDataDir({
        dataDir: arg, codeRepo: values.repo, name: values.name, prefix: values.prefix, defaultBranch: values['default-branch'],
        releaseBranch: values['release-branch'], github: values.github, layout: values.layout as 'dir' | 'orphan-branch' | undefined,
        commit: !values['no-commit'], log,
      });
      log(`initialized ${resolve(arg)} (${created.length} files created)`);
      break;
    }
    case 'check': {
      const dir = locateDataDir(arg);
      const store = await DataStore.open(dir, { lock: false, log: (l, m) => log(`[${l}] ${m}`) });
      const s = store.stats();
      log(`${dir}: schema ${store.config.schema_version} (${store.schema}), ${s.items} items, ${s.prompts} prompts, ${s.releases} releases, ${s.invalid} invalid`);
      for (const inv of store.invalid) log(`  INVALID ${inv.path}: ${inv.error}`);
      for (const item of store.listItems()) {
        const d = store.derived(item);
        if (d.base_branch_error) log(`  WARN ${item.id}: ${d.base_branch_error}`);
      }
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
      const host = values.host ?? '127.0.0.1'; const port = values.port ? Number(values.port) : 4300;
      if (values.watch) {
        const { supervise } = await import('./supervise.ts');
        await supervise({ dataDir: dir, serveArgs: [dir, ...(values.port ? ['--port', values.port] : []), ...(values.host ? ['--host', values.host] : []), ...(values.mock ? ['--mock'] : [])], host, port, open: values.open });
        break;
      }
      if (values.open) void import('./supervise.ts').then((m) => m.openWhenUp(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, log));
      const { startServer } = await import('./server.ts');
      await startServer({ dataDir: dir, port: values.port ? Number(values.port) : undefined, host: values.host, mock: values.mock });
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
      if (arg) { const r = liveInstance(resolve(arg)); log(r ? describeInstance(r) : `not running: ${resolve(arg)}`); if (!r) process.exitCode = 3; break; }
      const { live, pruned } = listInstances();
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
