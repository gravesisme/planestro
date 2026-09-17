#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { SCHEMA_VERSION } from '@planestro/shared';
import { DataStore } from './store/DataStore.ts';
import { initDataDir } from './init.ts';
import { migrate } from './migrations/index.ts';
import { locateDataDir, TOOL_VERSION } from './config.ts';

const USAGE = `planestro ${TOOL_VERSION}

  planestro init <data_dir> --repo <code_repo> [--name N] [--prefix HH] [--default-branch B] [--release-branch B] [--github owner/repo] [--layout dir|orphan-branch] [--no-commit]
  planestro check [data_dir]        validate every file and report
  planestro migrate [data_dir]      apply schema migrations (${SCHEMA_VERSION} is current)
  planestro serve [data_dir] [--port N] [--host H] [--mock] [--watch] [--open]
                                    run the web UI + engine (default host 127.0.0.1; use 0.0.0.0 for LAN access)
                                    --watch  restart on planestro source changes (between agent turns) and rebuild the UI
                                    --open   open the UI in a browser once it is up
  planestro sample [dir] [--reset] [--no-serve] [--port N]
                                    build a fictional project with a full backlog and serve it in dry-run:
                                    no repo, GitHub remote or Claude login needed (default dir .planestro/sample, port 4310)
  planestro version
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' }, name: { type: 'string' }, prefix: { type: 'string' }, 'default-branch': { type: 'string' },
    'release-branch': { type: 'string' }, github: { type: 'string' }, layout: { type: 'string' }, 'no-commit': { type: 'boolean' },
    commit: { type: 'boolean' }, 'copy-small': { type: 'boolean' }, data: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, port: { type: 'string' }, host: { type: 'string' }, mock: { type: 'boolean' }, watch: { type: 'boolean' }, open: { type: 'boolean' }, reset: { type: 'boolean' }, 'no-serve': { type: 'boolean' },
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
      log(`${dir}: schema ${store.config.schema_version} (${store.schema}), ${s.items} items, ${s.prompts} prompts, ${s.invalid} invalid`);
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
        await supervise({ serveArgs: [dir, ...(values.port ? ['--port', values.port] : []), ...(values.host ? ['--host', values.host] : []), ...(values.mock ? ['--mock'] : [])], host, port, open: values.open });
        break;
      }
      if (values.open) void import('./supervise.ts').then((m) => m.openWhenUp(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, log));
      const { startServer } = await import('./server.ts');
      await startServer({ dataDir: dir, port: values.port ? Number(values.port) : undefined, host: values.host, mock: values.mock });
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
    case 'version': log(TOOL_VERSION); break;
    default: log(USAGE); process.exit(cmd && cmd !== 'help' ? 1 : 0);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
