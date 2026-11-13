/**
 * One place that configures transformers.js for the browser, shared by the Web
 * Worker path (normal) and the main-thread fallback (browsers whose workers lack
 * OffscreenCanvas, e.g. Safari before iOS 16.4 and Playwright's WebKit on Windows).
 */
import { loadModels, type LoadedModels, type TextEmbeds } from './vision-core.ts';

type TF = typeof import('@huggingface/transformers');

/** origin = where /ort/ (ONNX runtime) lives; modelsOrigin = where /models/ lives (the server in the Android app). */
export function configureTf(tf: TF, origin: string, opts: { lowPower: boolean; proxy: boolean; modelsOrigin?: string }) {
  tf.env.allowLocalModels = false;
  tf.env.allowRemoteModels = true;
  tf.env.remoteHost = `${opts.modelsOrigin || origin}/models/`;
  tf.env.remotePathTemplate = '{model}/';
  tf.env.useBrowserCache = true;
  const wasm = tf.env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = `${origin}/ort/`;
    // Threads need cross-origin isolation (COOP/COEP, set by our server). Cap at 4 for
    // low-end phones; low-power mode keeps 1 thread.
    const iso = (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    wasm.numThreads = iso && !opts.lowPower ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    // Main-thread fallback: run ONNX Runtime in its own worker so inference never blocks the UI.
    if (opts.proxy) wasm.proxy = true;
  }
}

export async function loadBrowserModels(
  tf: TF,
  origin: string,
  preferGpu: boolean,
  progress?: (p: { file?: string; loaded?: number; total?: number; status: string }) => void,
): Promise<LoadedModels> {
  const res = await fetch(`${origin}/models/clip-text-embeds.json`);
  if (!res.ok) throw new Error('vision models are not downloaded on this phone');
  const text = (await res.json()) as TextEmbeds;
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const gpuOk = preferGpu && !!gpu && !!(await gpu.requestAdapter().catch(() => null));
  if (gpuOk) {
    try {
      return await loadModels(tf, text, 'webgpu', progress);
    } catch (e) {
      progress?.({ status: `WebGPU failed (${(e as Error).message}); falling back to WASM` });
    }
  }
  return loadModels(tf, text, 'wasm', progress);
}

export function meanColourOf(data: Uint8ClampedArray): [number, number, number] {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]!;
    g += data[i + 1]!;
    b += data[i + 2]!;
  }
  const n = data.length / 4 || 1;
  return [r / n, g / n, b / n];
}
