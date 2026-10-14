/**
 * The image tool's own staging, said by the runner that has it (HH-274): exec, and an app-server row with
 * `native_images` (HH-540). Workers read "nothing outside the worktree" as covering the folder the built-in
 * generator saves into, and blocked on their first generation. A data dir's copy of worker-system-codex
 * predates this, so it rides with every turn rather than in the prompt library.
 */
export const IMAGE_TOOL_NOTE = [
  '## Your image tool',
  '',
  '- The built-in image generator saves what it makes in its own folder ($CODEX_HOME/generated_images). That is the tool working as it always does, not a write of yours: it is allowed, and it never needs anyone\'s approval.',
  '- Copy each image you keep into the worktree: the final file at the path the plan names, raw generations under tmp/ when the plan asks for them. "Nothing outside the worktree" is about what your commands write.',
].join('\n');
