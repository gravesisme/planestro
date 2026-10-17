import { lazy, type ComponentType } from 'react';

const RELOADED = 'planestro.chunk-reload';

/**
 * A page loaded when first opened. `serve --watch` rebuilds the UI under an open page and the old chunks go with it:
 * a chunk that no longer loads reloads the page once (the new bundle has it), rather than leaving a crash screen.
 */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async () => {
    try {
      const page = await load();
      try { sessionStorage.removeItem(RELOADED); } catch { /* nothing kept */ }
      return { default: page };
    } catch (e) {
      let again = false;
      try { again = Boolean(sessionStorage.getItem(RELOADED)); sessionStorage.setItem(RELOADED, '1'); } catch { /* no storage: never reload, so never loop */ again = true; }
      if (!again) location.reload();
      throw e;
    }
  });
}
