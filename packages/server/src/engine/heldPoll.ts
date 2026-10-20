// The held-PR poll interval: driveHeld and the epics' reopen check both read it (#404: shared, so neither imports the other).

/** How often a held (skip_merge) pull request's branch and CI are looked at: one `ls-remote` and one run listing per item. */
export const HELD_POLL_MS = 60_000;
