/**
 * Main-thread vision FALLBACK for browsers whose workers have no OffscreenCanvas
 * (Safari before iOS 16.4; Playwright's WebKit on Windows). transformers.js does
 * its image decode/resize with `self.OffscreenCanvas`, so here we provide a shim
 * backed by a normal <canvas> (main thread only). Inference itself still runs
 * off the UI thread: ONNX Runtime's `proxy` mode puts it in its own worker.
 * Same vision-core.ts, same models, same output contract.
 */
import { modelOrigin } from './platform.ts';
import type { VisionSuggestion } from '@rusq/shared';
import { analyzeImage, mockAnalyze, type LoadedModels } from './vision-core.ts';
import { configureTf, loadBrowserModels, meanColourOf } from './vision-env.ts';

let shimInstalled = false;

/** Minimal OffscreenCanvas stand-in: a detached <canvas> plus convertToBlob(). */
function installCanvasShim() {
  if (shimInstalled || typeof OffscreenCanvas !== 'undefined') return;
  class CanvasShim {
    constructor(w: number, h: number) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      (c as unknown as { convertToBlob: (o?: { type?: string; quality?: number }) => Promise<Blob> }).convertToBlob = (o) =>
        new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), o?.type, o?.quality));
      return c as unknown as CanvasShim;
    }
  }
  (window as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = CanvasShim;
  shimInstalled = true;
}

let models: Promise<LoadedModels> | null = null;

function getModels(lowPower: boolean, progress?: (p: { status: string }) => void): Promise<LoadedModels> {
  if (!models) {
    models = (async () => {
      installCanvasShim();
      const tf = await import('@huggingface/transformers');
      configureTf(tf, location.origin, { lowPower, proxy: true, modelsOrigin: modelOrigin() });
      return loadBrowserModels(tf, modelOrigin(), true, progress);
    })();
    models.catch(() => (models = null));
  }
  return models;
}

export async function loadOnMain(lowPower: boolean, progress?: (p: { status: string }) => void) {
  const m = await getModels(lowPower, progress);
  return { loaded: true, backend: m.backend };
}

export async function analyzeOnMain(blob: Blob, opts: { mock: boolean; lowPower: boolean }): Promise<VisionSuggestion> {
  if (opts.mock) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0, 32, 32);
    return mockAnalyze(meanColourOf(ctx.getImageData(0, 0, 32, 32).data), () => performance.now());
  }
  const m = await getModels(opts.lowPower);
  const tf = await import('@huggingface/transformers');
  const image = await tf.RawImage.fromBlob(blob);
  return analyzeImage(m, image, () => performance.now());
}
