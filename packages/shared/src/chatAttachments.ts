/**
 * What the orchestrator chat takes (#288): images the model can see, and documents it can Read. Nothing a
 * browser or a shell would run (HTML, SVG, scripts): they are stored in the data dir and served back to the page.
 */
export type ChatAttachmentKind = 'image' | 'file';
export interface ChatAttachment { path: string; name: string; kind: ChatAttachmentKind; bytes: number }
/** Under `attachments/`, beside the items' folders: not an item id, so it never names one. */
export const CHAT_ATTACHMENTS_DIR = 'chat';
export const CHAT_MAX_FILES = 8;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const FILE = /\.(txt|md|markdown|json|csv|tsv|ya?ml|log|pdf)$/i;
/** For a file picker's `accept`. */
export const CHAT_ACCEPT = 'image/*,.txt,.md,.markdown,.json,.csv,.tsv,.yaml,.yml,.log,.pdf';

export function chatAttachmentKind(name: string): ChatAttachmentKind | undefined {
  return IMAGE.test(name) ? 'image' : FILE.test(name) ? 'file' : undefined;
}

export function chatAttachmentRefusal(files: { name: string; size: number }[], maxBytes: number): string | null {
  if (files.length > CHAT_MAX_FILES) return `at most ${CHAT_MAX_FILES} attachments in one message`;
  for (const f of files) {
    if (!chatAttachmentKind(f.name)) return `${f.name || 'that file'}: not a type the chat takes (images, text, markdown, JSON, CSV, YAML, logs and PDFs)`;
    if (f.size > maxBytes) return `${f.name}: over the ${Math.round(maxBytes / 1e5) / 10} MB attachment limit`;
  }
  return null;
}

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
/**
 * The largest file of this name copied onto an item: a picture may be `image_max_bytes` (#355: an art review's
 * full-quality captures), anything else `managed_max_bytes`; the larger of the two applies to a picture.
 */
export function managedLimit(limits: { managed_max_bytes: number; image_max_bytes?: number }, name: string): number {
  return PICTURE.test(name) ? Math.max(limits.managed_max_bytes, limits.image_max_bytes ?? 0) : limits.managed_max_bytes;
}
