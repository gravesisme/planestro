/**
 * Codex's apply_patch refuses a patch with several operations on one file and ends the whole turn (#344): workers
 * patched a tmp/*.json manifest piecemeal and stopped. Said by both Codex runners on every turn, like IMAGE_TOOL_NOTE.
 */
export const APPLY_PATCH_NOTE = 'apply_patch takes one operation per file: never several operations on the same file in one patch. Rewrite a small JSON or manifest file whole rather than patching it several times.';
