import { describe, it, expect } from 'vitest';
import { chatAttachmentKind, chatAttachmentRefusal, CHAT_MAX_FILES } from '../src/chatAttachments.ts';

describe('what the orchestrator chat takes (#288)', () => {
  it('images and readable documents; nothing a browser or a shell would run', () => {
    for (const n of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp']) expect(chatAttachmentKind(n), n).toBe('image');
    for (const n of ['notes.md', 'log.txt', 'data.json', 'rows.csv', 'cfg.yaml', 'cfg.yml', 'run.log', 'spec.pdf', 'x.markdown', 'y.tsv']) expect(chatAttachmentKind(n), n).toBe('file');
    for (const n of ['page.html', 'logo.svg', 'tool.exe', 'script.sh', 'photo.heic', 'noext', '']) expect(chatAttachmentKind(n), n).toBeUndefined();
  });

  it('refuses in words: a type it does not take, one too many, one over the size limit', () => {
    expect(chatAttachmentRefusal([{ name: 'a.png', size: 10 }, { name: 'n.md', size: 10 }], 100)).toBeNull();
    expect(chatAttachmentRefusal([{ name: 'p.html', size: 10 }], 100)).toMatch(/p\.html: .*not a type/);
    expect(chatAttachmentRefusal([{ name: 'big.pdf', size: 2_500_000 }], 2_000_000)).toMatch(/big\.pdf: .*2 MB/);
    expect(chatAttachmentRefusal(Array.from({ length: CHAT_MAX_FILES + 1 }, (_, i) => ({ name: `${i}.png`, size: 1 })), 100)).toMatch(new RegExp(`at most ${CHAT_MAX_FILES}`));
  });
});
