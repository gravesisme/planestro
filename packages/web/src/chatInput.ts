import { chatAttachmentKind } from '@planestro/shared/view';
import { isImage } from './uploadImage.ts';

/**
 * The orchestrator chat's input (#288), like the Claude app's: one line that grows with the message up to 40% of
 * the room the chat has and scrolls inside past that. Enter sends at a keyboard; on a phone Enter is a new line and Send sends.
 */
export const GROW_MAX = 0.4;

export function enterSends(k: { key: string; shiftKey: boolean; isComposing: boolean }, touch: boolean): boolean {
  return k.key === 'Enter' && !k.shiftKey && !k.isComposing && !touch;
}

export function growTo(scrollHeight: number, viewport: number): { height: number; scroll: boolean } {
  const cap = Math.round(viewport * GROW_MAX);
  return { height: Math.min(scrollHeight, cap), scroll: scrollHeight > cap };
}

/** A touch screen or a phone-width window: where Enter can't be told from "new line". */
export const isTouch = (): boolean => { try { return matchMedia('(pointer: coarse)').matches || innerWidth <= 640; } catch { return false; } };

/** The files the chat takes from a paste or a pick: images (photos are converted before upload) and readable documents. */
export function pickable(files: File[]): { take: File[]; skipped: string[] } {
  const take: File[] = [], skipped: File[] = [];
  for (const f of files) (isImage(f) || chatAttachmentKind(f.name) ? take : skipped).push(f);
  return { take, skipped: skipped.map((f) => f.name) };
}
