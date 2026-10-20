// The turn ops a restart resumes (resumeInterrupted); the reconciler leaves them to it (#404: shared, so neither imports the other).

export const RESUMABLE_TURN_OPS = new Set(['planning_turn', 'implement_turn']);
