import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomicWrite.ts';

/** `counter` holds the next number; ids are never reused even if the file is behind. */
export class IdAllocator {
  constructor(private readonly dataDir: string, private readonly prefix: string) {}

  private get file(): string { return join(this.dataDir, 'counter'); }

  peek(): number {
    if (!existsSync(this.file)) return 1;
    const n = Number(readFileSync(this.file, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : 1;
  }

  /** Allocate the next id, never below `maxExisting + 1`. */
  allocate(maxExisting: number): string {
    const n = Math.max(this.peek(), maxExisting + 1);
    atomicWrite(this.file, `${n + 1}\n`);
    return `${this.prefix}-${n}`;
  }
}
