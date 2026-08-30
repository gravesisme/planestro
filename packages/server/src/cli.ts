#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { SCHEMA_VERSION } from '@planestro/shared';
import { DataStore } from './store/DataStore.ts';
import { initDataDir } from './init.ts';
import { migrate, currentVersion } from './migrations/index.ts';
import { locateDataDir, TOOL_VERSION } from './config.ts';

const USAGE = `planestro ${TOOL_VERSION}

  planestro init <data_dir> --repo <code_repo> [--name N] [--prefix HH] [--default-branch B] [--release-branch B] [--github owner/repo] [--layout dir|orphan-branch] [--no-commit]
  planestro check [data_dir]        validate every file and report
  planestro migrate [data_dir]      apply schema migrations (${SCHEMA_VERSION} is current)
  planestro serve [data_dir]        run the web UI + engine (Phase 2+)
  planestro version
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' }, name: { type: 'string' }, prefix: { type: 'string' }, 'default-branch': { type: 'string' },
    'release-branch': { type: 'string' }, github: { type: 'string' }, layout: { type: 'string' }, 'no-commit': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, port: { type: 'string' },
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
    case 'serve': {
      const dir = locateDataDir(arg);
      const v = currentVersion(dir);
      log(`serve is not available yet (Phase 2). data dir ${dir} is schema ${v}.`);
      process.exit(2);
    }
    case 'version': log(TOOL_VERSION); break;
    default: log(USAGE); process.exit(cmd && cmd !== 'help' ? 1 : 0);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
