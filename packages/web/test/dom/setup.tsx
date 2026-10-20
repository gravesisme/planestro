import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// What jsdom leaves out and the components reach for: none of it is under test, so each is the quietest stand-in.
if (!window.matchMedia) window.matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
