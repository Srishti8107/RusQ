/**
 * Main-thread client for the vision worker, plus the "are models stored?" check
 * used by the setup checklist. Every failure path ends in MANUAL tagging with a
 * clear notice – the report form never depends on vision.
 */
import { isNativeApp, modelOrigin } from './platform.ts';
import { VisionSuggestion } from '@rusq/shared';
import { getSettings } from './session.ts';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: unknown) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/vision.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; type: string; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      if (e.data.type === 'progress') return p.onProgress?.(e.data);
      pending.delete(e.data.id);
      if (e.data.type === 'error') p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'vision worker crashed'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function call<T>(msg: Record<string, unknown>, onProgress?: (p: unknown) => void, timeoutMs = 120_000): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error('vision timed out'));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => (clearTimeout(t), resolve(v as T)),
      reject: (e) => (clearTimeout(t), reject(e)),
      onProgress,
    });
    getWorker().postMessage({ id, ...msg });
  });
}

/**
 * Decided once, before any shim is installed: without OffscreenCanvas the worker
 * cannot decode/resize images, so we use the main-thread fallback (vision-main.ts).
 */
export const VISION_MODE: 'worker' | 'main-thread' = typeof OffscreenCanvas === 'undefined' ? 'main-thread' : 'worker';

export async function loadVision(onProgress?: (p: { file?: string; loaded?: number; total?: number; status: string }) => void) {
  const { lowPower } = await getSettings();
  if (VISION_MODE === 'main-thread') return (await import('./vision-main.ts')).loadOnMain(lowPower, onProgress);
  return call<{ loaded: boolean; backend: string }>({ type: 'load', preferGpu: true, lowPower, modelsOrigin: modelOrigin() }, onProgress as (p: unknown) => void, 600_000);
}

export async function analyzePhoto(blob: Blob, opts: { mock?: boolean } = {}): Promise<VisionSuggestion> {
  const { lowPower } = await getSettings();
  const raw =
    VISION_MODE === 'main-thread'
      ? await withTimeout((await import('./vision-main.ts')).analyzeOnMain(blob, { mock: !!opts.mock, lowPower }), 90_000)
      : await call<unknown>({ type: 'analyze', blob, mock: !!opts.mock, lowPower, modelsOrigin: modelOrigin() }, undefined, 90_000);
  return VisionSuggestion.parse(raw); // schema-validated before it touches the form
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('vision timed out')), ms))]);
}

export interface ModelFile {
  url: string;
  bytes: number;
}

/** Files the phone must hold for offline vision (from /models/manifest.json). */
export async function modelFiles(): Promise<ModelFile[]> {
  const res = await fetch(`${modelOrigin()}/models/manifest.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error('model manifest unavailable');
  const m = (await res.json()) as { models: Record<string, { file: string; bytes: number }[]>; extra: { file: string; bytes: number }[] };
  const out: ModelFile[] = [];
  for (const [model, files] of Object.entries(m.models)) for (const f of files) out.push({ url: `${modelOrigin()}/models/${model}/${f.file}`, bytes: f.bytes });
  for (const f of m.extra) out.push({ url: `${modelOrigin()}/models/${f.file}`, bytes: f.bytes });
  return out;
}

/**
 * Verifies the models are ACTUALLY stored (Cache API), not just "downloaded once".
 * transformers.js stores model files in the "transformers-cache" cache; the SW
 * runtime-caches /models/ and /ort/ in "rusq-models".
 */
export async function verifyModelsStored(files?: ModelFile[]): Promise<{ ok: boolean; missing: string[] }> {
  if (!('caches' in self)) return { ok: false, missing: ['Cache API unavailable'] };
  const list = files ?? (await cachedManifest());
  const missing: string[] = [];
  for (const f of list) {
    const hit = (await caches.match(f.url)) ?? (await (await caches.open('transformers-cache')).match(f.url));
    if (!hit) missing.push(f.url.replace(modelOrigin(), ''));
  }
  // the ONNX runtime is inside the Android app; on the website it must be cached
  if (!isNativeApp) {
    const ort = await caches.match(`${location.origin}/ort/ort-wasm-simd-threaded.jsep.wasm`);
    if (!ort) missing.push('/ort/ort-wasm-simd-threaded.jsep.wasm');
  }
  return { ok: missing.length === 0, missing };
}

async function cachedManifest(): Promise<ModelFile[]> {
  const hit = await caches.match(`${modelOrigin()}/models/manifest.json`);
  if (!hit) return modelFiles();
  const m = (await hit.json()) as { models: Record<string, { file: string; bytes: number }[]>; extra: { file: string; bytes: number }[] };
  const out: ModelFile[] = [];
  for (const [model, files] of Object.entries(m.models)) for (const f of files) out.push({ url: `${modelOrigin()}/models/${model}/${f.file}`, bytes: f.bytes });
  for (const f of m.extra) out.push({ url: `${modelOrigin()}/models/${f.file}`, bytes: f.bytes });
  return out;
}

/** Pre-fetch everything into the runtime cache (so offline works even before first analysis). */
export async function downloadModelFiles(onProgress: (done: number, total: number) => void): Promise<void> {
  const files = await modelFiles();
  const cache = await caches.open('rusq-models');
  await cache.add(`${modelOrigin()}/models/manifest.json`);
  const all = isNativeApp ? files : [...files, { url: `${location.origin}/ort/ort-wasm-simd-threaded.jsep.wasm`, bytes: 21_600_000 }, { url: `${location.origin}/ort/ort-wasm-simd-threaded.jsep.mjs`, bytes: 50_000 }];
  const total = all.reduce((s, f) => s + f.bytes, 0);
  // transformers.js looks for model files in its own cache; in the Android app there is no service
  // worker to bridge the two, so the same file is put there too (no second 85 MB download).
  const tfCache = isNativeApp ? await caches.open('transformers-cache') : null;
  let done = 0;
  for (const f of all) {
    if (!(await cache.match(f.url))) {
      const blob = await fetchResumable(f.url, f.bytes, (got) => onProgress(done + got, total));
      const headers = { 'content-type': f.url.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'content-length': String(blob.size) };
      await cache.put(f.url, new Response(blob, { headers }));
      if (tfCache) await tfCache.put(f.url, new Response(blob, { headers }));
    } else if (tfCache && !(await tfCache.match(f.url))) {
      await tfCache.put(f.url, (await cache.match(f.url))!);
    }
    done += f.bytes;
    onProgress(done, total);
  }
}

const PIECE = 4 * 1024 * 1024;

/**
 * Download a file in 4 MB pieces (HTTP Range), retrying only the piece that failed. A long single
 * request through a tunnel or a weak mobile link is often cut ("stream canceled"); before, that
 * restarted the whole 85 MB model and ended in "Cache.put() encountered a network error".
 */
async function fetchResumable(url: string, expected: number, onBytes: (got: number) => void): Promise<Blob> {
  if (expected < PIECE * 2) return fetchWithRetry(url, undefined).then((r) => r.blob());
  const parts: Blob[] = [];
  let got = 0;
  let size = expected;
  while (got < size) {
    const end = Math.min(got + PIECE, size) - 1;
    const res = await fetchWithRetry(url, `bytes=${got}-${end}`);
    if (res.status === 200) {
      // server ignored the range: it sent the whole file in one go
      const whole = await res.blob();
      onBytes(whole.size);
      return whole;
    }
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]);
    if (total > 0) size = total;
    const piece = await res.blob();
    if (piece.size === 0) throw new Error(`download failed: ${url} (empty piece)`);
    parts.push(piece);
    got += piece.size;
    onBytes(got);
  }
  return new Blob(parts);
}

async function fetchWithRetry(url: string, range: string | undefined, tries = 6): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { cache: 'no-store', headers: range ? { range } : undefined });
      if (res.ok || res.status === 206) {
        // read the body here so a cut connection is caught and retried, not passed on
        const buf = await res.arrayBuffer();
        return new Response(buf, { status: res.status, headers: res.headers });
      }
      last = new Error(`download failed: ${url} (${res.status})`);
      if (res.status === 404) break;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** i))); // 1, 2, 4, 8, 15 s
  }
  throw last instanceof Error ? new Error(`${last.message} – check the connection and tap again; finished files are kept`) : new Error('download failed');
}

export function terminateVision() {
  worker?.terminate();
  worker = null;
}
