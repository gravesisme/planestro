/**
 * Exit codes `planestro serve` uses for "someone else already owns this", so the `--watch`
 * supervisor can tell them from a crash. A crash waits for the next source change; these are
 * fatal, because no source change will free the data dir or the port — idling on them is how a
 * project ended up with no server and nothing saying so (#85, LM 2026-09-28).
 */
export const EXIT_DATA_DIR_IN_USE = 10;
export const EXIT_PORT_IN_USE = 11;

/** Another live planestro holds `<data_dir>/.planestro/lock`. */
export class DataDirInUseError extends Error {
  readonly exitCode = EXIT_DATA_DIR_IN_USE;
  constructor(readonly pid: number, lock: string) { super(`data dir is in use by planestro pid ${pid} (${lock})`); }
}

/** The listen address is taken (EADDRINUSE), by planestro or anything else. */
export class PortInUseError extends Error {
  readonly exitCode = EXIT_PORT_IN_USE;
  constructor(host: string, port: number) { super(`port ${port} on ${host} is already in use (EADDRINUSE)`); }
}

export function exitCodeFor(e: unknown): number {
  return e instanceof DataDirInUseError || e instanceof PortInUseError ? e.exitCode : 1;
}
