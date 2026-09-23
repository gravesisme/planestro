/**
 * Get a picked file ready for an attachment upload.
 *
 * Phones hand a web page photos that the server and the previews can't use as
 * they are: HEIC/HEIF straight from an iPhone's library (the preview regex and
 * the server's content types only know png/jpeg/gif/webp), and 12 MP JPEGs
 * that blow past `attachments.managed_max_bytes`. So any image the browser
 * can decode is redrawn into a canvas, downscaled to a sane long edge and
 * re-encoded as JPEG under the size limit. Anything else passes through.
 */
const WEB_IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const HEIC = /\.(heic|heif)$/i;
export const MAX_EDGE_PX = 2560;

export function isImage(file: File): boolean {
  return file.type.startsWith('image/') || WEB_IMAGE.test(file.name) || HEIC.test(file.name);
}

/** True when the file must be converted even if it's already small: formats the server and previews don't know. */
export function needsConversion(file: File): boolean {
  if (HEIC.test(file.name) || /image\/hei[cf]/i.test(file.type)) return true;
  return isImage(file) && !WEB_IMAGE.test(file.name);
}

/** JPEG name for a converted file: `IMG_0042.HEIC` becomes `IMG_0042.jpg`. */
export function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '') || 'photo';
  return `${base}.jpg`;
}

/** Scale (w, h) down so the long edge is at most `max`, never up. */
export function fitWithin(w: number, h: number, max: number = MAX_EDGE_PX): { w: number; h: number } {
  const long = Math.max(w, h);
  if (long <= max) return { w, h };
  const k = max / long;
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

async function decode(file: File): Promise<{ source: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch { /* fall through to <img>, which decodes HEIC on Safari */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode JPEG'))), 'image/jpeg', quality));
}

/**
 * The file to upload. Non-images and small web-format images are returned
 * untouched. Everything else is re-encoded as JPEG within `maxBytes`, or
 * rejected with a message the page can show.
 */
export async function prepareUpload(file: File, maxBytes: number): Promise<File> {
  if (!isImage(file)) return file;
  if (!needsConversion(file) && file.size <= maxBytes) return file;
  let decoded;
  try {
    decoded = await decode(file);
  } catch {
    if (HEIC.test(file.name)) throw new Error(`${file.name}: this browser can't read HEIC photos. Pick it from Photos (not Files), or set the iPhone camera to "Most Compatible".`);
    throw new Error(`${file.name}: not an image this browser can read`);
  }
  try {
    let { w, h } = fitWithin(decoded.w, decoded.h);
    const canvas = document.createElement('canvas');
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      ctx.fillStyle = '#fff'; // JPEG has no alpha: flatten onto white, not black
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(decoded.source, 0, 0, w, h);
      const blob = await toJpeg(canvas, attempt < 3 ? 0.86 - attempt * 0.12 : 0.6);
      if (blob.size <= maxBytes) return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
      ({ w, h } = { w: Math.round(w * 0.75), h: Math.round(h * 0.75) });
    }
    throw new Error(`${file.name}: still over ${Math.round(maxBytes / 1e6)} MB after shrinking`);
  } finally {
    decoded.close();
  }
}
