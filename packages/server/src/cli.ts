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
  planestro serve [data_dir] [--port N] [--host H] [--mock]   run the web UI + engine (default host 127.0.0.1; use 0.0.0.0 for LAN access)
  planestro version
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' }, name: { type: 'string' }, prefix: { type: 'string' }, 'default-branch': { type: 'string' },
    'release-branch': { type: 'string' }, github: { type: 'string' }, layout: { type: 'string' }, 'no-commit': { type: 'boolean' },
    commit: { type: 'boolean' }, 'copy-small': { type: 'boolean' }, data: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, port: { type: 'string' }, host: { type: 'string' }, mock: { type: 'boolean' },
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
      const { importPrompts } = await import('./import/promptsImport.ts');
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
      const { startServer } = await import('./server.ts');
      await startServer({ dataDir: dir, port: values.port ? Number(values.port) : undefined, host: values.host, mock: values.mock });
      break;
    }
    case 'version': log(TOOL_VERSION); break;
    default: log(USAGE); process.exit(cmd && cmd !== 'help' ? 1 : 0);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
