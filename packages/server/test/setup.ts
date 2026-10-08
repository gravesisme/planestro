import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// No test reads the real ~/.planestro (its registry, instances or machine policy, #229): every file starts in a home of its own.
process.env.PLANESTRO_HOME = mkdtempSync(join(tmpdir(), 'planestro-home-'));
