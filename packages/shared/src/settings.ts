/**
 * The settings registry (issue #83) lives in settingsView.ts, free of zod for the web's view entry (#408).
 * Here is the part that reads the zod schema: a key's default, and whether a value differs from it.
 */
import { Config, LocalConfig } from './schema.ts';
import type { SettingDef, SettingFile } from './settingsView.ts';

export * from './settingsView.ts';

/** The zod node at a dotted key, through defaults and optionals. */
function schemaAt(root: unknown, key: string): any {
  let cur: any = root;
  for (const part of key.split('.')) {
    cur = unwrap(cur);
    cur = cur?.shape?.[part];
    if (!cur) return undefined;
  }
  return cur;
}
function unwrap(s: any): any { for (let i = 0; i < 6 && s && !s.shape && (s.def?.type === 'default' || s.def?.type === 'optional' || s.def?.type === 'prefault'); i++) s = s.def.innerType; return s; }

/**
 * What planestro uses when the key is not set: `{ value }` from the schema's default, `{ none: true }`
 * for an optional key without one, or undefined for a required key (it has no default to differ from).
 */
export function settingDefault(file: SettingFile, key: string): { value: unknown } | { none: true } | undefined {
  const node = schemaAt(file === 'config' ? Config : LocalConfig, key);
  if (!node) return undefined;
  let s: any = node;
  for (let i = 0; i < 6 && s; i++) {
    if (s.def?.type === 'default') return { value: typeof s.def.defaultValue === 'function' ? s.def.defaultValue() : s.def.defaultValue };
    if (s.def?.type === 'optional') return { none: true };
    s = s.def?.innerType;
  }
  // Inside a defaulted parent object (worktrees: … .default({...})), the parent's default names it.
  const parts = key.split('.');
  if (parts.length > 1) { const parent = settingDefault(file, parts.slice(0, -1).join('.')); if (parent && 'value' in parent && parent.value && typeof parent.value === 'object') return { value: (parent.value as Record<string, unknown>)[parts.at(-1)!] }; }
  return undefined;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Whether the current value differs from what planestro would use unset (never for required keys or the whole-list editors). */
export function settingChanged(def: SettingDef, value: unknown): boolean {
  if (def.control === 'models' || def.control === 'categories' || def.control === 'mcp' || def.control === 'devices') return false;
  const d = settingDefault(def.file, def.key);
  if (!d) return false;
  if ('none' in d) return value !== undefined && value !== '' && !(Array.isArray(value) && !value.length);
  if (value === undefined) return false;
  return !same(value, d.value);
}
