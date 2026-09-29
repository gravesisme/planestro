import { describe, it, expect } from 'vitest';
import { holdShapeOf, heldReasonOf } from '../src/hold.ts';

describe('a merge hold stated in a plan (#97, LM-22)', () => {
  it('finds the sentence that states the hold, and what it waits for', () => {
    expect(holdShapeOf('# Plan\n\n1. Draw the sprites.\n2. Open the PR.\n\nPR stays held until the designer signs off on the sprites. Then it merges.')).toEqual({
      quote: 'PR stays held until the designer signs off on the sprites.',
      reason: 'until the designer signs off on the sprites',
    });
    expect(holdShapeOf("Don't merge this PR before the migration has run in staging.")?.reason).toBe('until the migration has run in staging');
    expect(holdShapeOf('Merge only after HH-120 has merged.')?.reason).toBe('until HH-120 has merged');
    expect(holdShapeOf('**Hold:** the designer reviews the atlas first')?.reason).toBe('the designer reviews the atlas first');
    expect(holdShapeOf('Needs a design review before the PR is merged.')?.reason).toBe('Needs a design review before the PR is merged');
  });

  const held = [
    'The pull request remains on hold until HH-210 has merged.',
    '- **Do not merge** until the 0.4.0 release is cut.',
    'This must not be merged until legal approves the licence text.',
    'Do not merge into develop until HH-3 is in.',
    'Hold the PR until the art children land.',
    'Keep the pull request as a draft until the API key is rotated.',
    'Hold off on merging until the freeze lifts.',
    'It should only be merged once the designer has reviewed the captures.',
    'The PR merges only after the release is tagged.',
    '## Merge\n\nHeld until the store listing is approved.',
    'Merge hold: until the 1.2 branch is cut',
    '3. Open the PR. It stays held until the playtest on Friday.',
    "The designer's sign-off is needed before merging.",
    'The PR should stay held pending the security review.',
    'This change must stay unmerged until the feature flag exists.',
    'The PR is kept on hold until QA confirms.',
    '> The PR (#312) stays held until HH-9 merges.',
    'Set `skip_merge` until HH-3 has merged.',
    '| Step | Note |\n|---|---|\n| Merge | The PR stays held until the vendor confirms |',
  ];
  it.each(held)('a hold: %s', (plan) => { expect(holdShapeOf(plan)).not.toBeNull(); });

  const ordinary = [
    'Hold the lock until the transaction commits.',
    'The mutex is held until the write completes.',
    'Merge the two arrays before sorting them.',
    'Do not merge the two arrays until both are sorted.',
    'Orders on hold are shown in grey.',
    'The order stays on hold until payment clears.',
    'Run the full test suite before merging.',
    'planestro rebases the branch before merging.',
    'This change ensures the connection is held until the request completes.',
    'Add a `hold` button to the toolbar.',
    'Thresholds are read from config.',
    'The item is held until the player drops it.',
    'It is held until the key is released.',
    'Keep the branch up to date with develop.',
    'Hold the button for two seconds to confirm.',
    'Wait until the animation ends, then merge the sprite sheets.',
    'No merge conflicts are expected.',
    'Household settings are merged only when both users agree.',
    'The cache entry stays held while the request runs.',
    'Do not merge duplicate rows before the dedupe pass.',
    'The reviewer approved the design before the merge window opened.',
    'CI needs to pass before merging.',
    'Layers are merged only after the mask is applied.',
    'The draft stays in draft until the user publishes it.',
    'A review is required before merging user accounts.',
    'The PR does not need to be held.',
    'No hold is needed: this merges as usual.',
    '',
  ];
  it.each(ordinary)('not a hold: %s', (plan) => { expect(holdShapeOf(plan)).toBeNull(); });

  it('leaves fenced code out, and keeps a table cell to itself', () => {
    expect(holdShapeOf('Steps:\n\n```ts\n// do not merge until reviewed\n```\n\nThen open the PR.')).toBeNull();
    expect(holdShapeOf('~~~\nThe PR stays held until X.\n~~~')).toBeNull();
    expect(holdShapeOf('| Merge | The PR stays held until the vendor confirms |')?.reason).toBe('until the vendor confirms');
  });

  it('caps what it quotes', () => {
    const long = `The PR stays held until ${'the very long condition '.repeat(30)}is met.`;
    const flag = holdShapeOf(long)!;
    expect(flag.quote.length).toBeLessThanOrEqual(300);
    expect(flag.reason.length).toBeLessThanOrEqual(200);
    expect(flag.reason.endsWith('…')).toBe(true);
  });

  it('a reason is shown only while the item is held', () => {
    expect(heldReasonOf({ skip_merge: true, hold_reason: ' until X ' })).toBe('until X');
    expect(heldReasonOf({ hold_reason: 'until X' })).toBeUndefined();
    expect(heldReasonOf({ skip_merge: true })).toBeUndefined();
  });
});
