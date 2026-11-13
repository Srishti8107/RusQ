/**
 * Photo processing before analysis AND before transmission (§8A, §8C):
 *  - full image downscaled to ≤ 1280 px, JPEG q≈0.7
 *  - thumbnail ≤ 320 px (sent first over the relay)
 *  - re-encoding through a canvas drops ALL EXIF metadata (incl. GPS). Location
 *    is only kept if the rescuer explicitly ticks "attach my location", and then
 *    as a separate visible field – never hidden inside the file.
 */
export const FULL_EDGE = 1280;
export const THUMB_EDGE = 320;
export const JPEG_QUALITY = 0.7;
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;

export class PhotoError extends Error {}

export interface ProcessedPhoto {
  blob: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

export async function processPhoto(file: Blob): Promise<ProcessedPhoto> {
  if (file.size === 0) throw new PhotoError('The photo is empty.');
  if (file.size > MAX_INPUT_BYTES) throw new PhotoError('The photo file is too big (over 40 MB). Please take a new photo.');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    throw new PhotoError('This file is not a readable photo (it may be damaged). Please take a new photo.');
  }
  try {
    const full = await encode(bmp, FULL_EDGE);
    const thumb = await encode(bmp, THUMB_EDGE);
    return { blob: full.blob, thumb: thumb.blob, width: full.width, height: full.height };
  } catch (e) {
    throw new PhotoError(`Could not process this photo (${(e as Error).message}). It may be too large for this phone.`);
  } finally {
    bmp.close();
  }
}

async function encode(bmp: ImageBitmap, maxEdge: number): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2D context');
    ctx.drawImage(bmp, 0, 0, w, h);
    return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY }), width: w, height: h };
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('no 2D context');
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('encode failed');
  return { blob, width: w, height: h };
}
