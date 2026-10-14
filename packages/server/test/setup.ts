import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// No test reads the real ~/.planestro (its registry, instances or machine policy, #229): every file starts in a home of its own.
process.env.PLANESTRO_HOME = mkdtempSync(join(tmpdir(), 'planestro-home-'));

// Nor the developer's git config: signing, hooks or aliases there would slow or change every commit the suites make.
// The identity and default branch are the ones CI sets (.github/workflows/ci.yml), so a run here sees the git CI sees.
const gitConfig = join(mkdtempSync(join(tmpdir(), 'planestro-git-')), 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = planestro test\n\temail = test@planestro.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
