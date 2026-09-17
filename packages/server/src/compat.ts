/**
 * Versions of Claude Code and the Agent SDK against which the Phase 0 spike
 * (spikes/sdk-spike.ts, findings in docs/notes/sdk-notes.md) validated every
 * orchestration assumption. planestro compares these against the installed
 * CLI at startup and shows a non-blocking warning when they drift.
 */
export const VALIDATED_CLAUDE_VERSION = '2.1.251';
export const VALIDATED_SDK_VERSION = '0.3.251';
export const VALIDATED_ON = '2026-08-30';

/** The Codex CLI the Codex runner was validated against (spikes/codex-spike.ts, docs/notes/codex-spike.md). */
export const VALIDATED_CODEX_VERSION = '0.154.0';
export const CODEX_VALIDATED_ON = '2026-09-17';
