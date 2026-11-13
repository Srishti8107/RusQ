/// <reference lib="webworker" />
/**
 * Vision Web Worker (§8C): all model loading and inference happens here so the
 * UI thread never blocks. Models are served by our own origin (/models/,
 * downloaded in setup) and cached by transformers.js in the Cache API
 * ("transformers-cache"), so they work with the network blocked.
 * Backend: WebGPU if available, otherwise WASM (ORT runtime self-hosted at /ort/).
 * Browsers whose workers lack OffscreenCanvas use the main-thread fallback
 * (lib/vision-main.ts) instead – see lib/vision.ts.
 */
import { CLIP_MODEL, DETECT_MODEL, analyzeImage, mockAnalyze, type LoadedModels } from '../lib/vision-core.ts';
import { configureTf, loadBrowserModels, meanColourOf } from '../lib/vision-env.ts';

type Req =
  | { id: number; type: 'load'; preferGpu: boolean; lowPower?: boolean }
  | { id: number; type: 'analyze'; blob: Blob; mock: boolean; lowPower?: boolean }
  | { id: number; type: 'status' };

let models: LoadedModels | null = null;
let loading: Promise<LoadedModels> | null = null;
let lastError: string | null = null;
let lowPower = false;

const post = (m: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

async function load(preferGpu: boolean, id: number): Promise<LoadedModels> {
  if (models) return models;
  if (loading) return loading;
  loading = (async () => {
    const tf = await import('@huggingface/transformers');
    configureTf(tf, self.location.origin, { lowPower, proxy: false });
    return loadBrowserModels(tf, self.location.origin, preferGpu, (p) => post({ id, type: 'progress', ...p }));
  })();
  try {
    models = await loading;
    lastError = null;
    return models;
  } catch (e) {
    lastError = (e as Error).message;
    throw e;
  } finally {
    loading = null;
  }
}

async function meanColour(blob: Blob): Promise<[number, number, number]> {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(32, 32);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, 32, 32);
  return meanColourOf(ctx.getImageData(0, 0, 32, 32).data);
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  if ('lowPower' in req && req.lowPower !== undefined) lowPower = req.lowPower;
  try {
    if (req.type === 'status') {
      post({
        id: req.id,
        type: 'result',
        result: { loaded: !!models, backend: models?.backend ?? null, lastError, models: [CLIP_MODEL, DETECT_MODEL], offscreenCanvas: typeof OffscreenCanvas !== 'undefined' },
      });
    } else if (req.type === 'load') {
      const m = await load(req.preferGpu, req.id);
      post({ id: req.id, type: 'result', result: { loaded: true, backend: m.backend } });
    } else if (req.type === 'analyze') {
      if (req.mock) {
        post({ id: req.id, type: 'result', result: mockAnalyze(await meanColour(req.blob), () => performance.now()) });
        return;
      }
      const m = await load(true, req.id);
      const tf = await import('@huggingface/transformers');
      const image = await tf.RawImage.fromBlob(req.blob);
      post({ id: req.id, type: 'result', result: await analyzeImage(m, image, () => performance.now()) });
    }
  } catch (err) {
    post({ id: req.id, type: 'error', error: (err as Error).message ?? String(err) });
  }
};
