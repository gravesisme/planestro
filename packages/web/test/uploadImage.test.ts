import { describe, expect, it } from 'vitest';
import { fitWithin, isImage, jpegName, needsConversion, prepareUpload } from '../src/uploadImage.ts';

const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type });

describe('uploadImage', () => {
  it('names converted photos .jpg', () => {
    expect(jpegName('IMG_0042.HEIC')).toBe('IMG_0042.jpg');
    expect(jpegName('shot.png')).toBe('shot.jpg');
    expect(jpegName('noext')).toBe('noext.jpg');
  });

  it('shrinks only past the long-edge cap', () => {
    expect(fitWithin(4032, 3024)).toEqual({ w: 2560, h: 1920 });
    expect(fitWithin(3024, 4032)).toEqual({ w: 1920, h: 2560 });
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 });
  });

  it('knows which files are photos needing conversion', () => {
    expect(needsConversion(file('IMG.HEIC', ''))).toBe(true);
    expect(needsConversion(file('x.heif', 'image/heif'))).toBe(true);
    expect(needsConversion(file('photo', 'image/heic'))).toBe(true);
    expect(needsConversion(file('a.png', 'image/png'))).toBe(false);
    expect(needsConversion(file('a.jpg', 'image/jpeg'))).toBe(false);
    expect(isImage(file('notes.txt', 'text/plain'))).toBe(false);
    expect(isImage(file('IMG.HEIC', ''))).toBe(true);
  });

  it('passes through non-images and small web images untouched', async () => {
    const txt = file('notes.txt', 'text/plain');
    expect(await prepareUpload(txt, 1000)).toBe(txt);
    const png = file('a.png', 'image/png', 500);
    expect(await prepareUpload(png, 1000)).toBe(png);
  });
});
