/**
 * Vision core (§8C) – pure functions over transformers.js, used by BOTH the
 * browser Web Worker and the Node evaluation script, so the evaluated code is
 * the shipped code.
 *
 * Hazard tagging : CLIP ViT-B/32 vision tower (q8) → TRAINED linear head (hazard-head.json,
 *                  tests/vision-train/train.ts: reviewed flood / fire / … photos and video frames,
 *                  CCTV-style variants) → softmax. Fallback when no head is given: zero-shot
 *                  cosine against the precomputed text embeddings × 100.
 * Counting       : YOLOS-tiny (q8) COCO detector → people / boats, as an estimate.
 * Output is ADVISORY – it only pre-fills an editable suggestion.
 */
import { HAZARD_LABELS, hazardsFromLabels, type VisionSuggestion } from '@rusq/shared';

export const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';
export const DETECT_MODEL = 'Xenova/yolos-tiny';
export const VISION_VERSION = 'vision-2.0.0';
export const MAX_ANALYSIS_EDGE = 4096;
export const DETECT_EDGE = 640;

type TF = typeof import('@huggingface/transformers');

export interface TextEmbeds {
  model: string;
  logitScale: number;
  dim: number;
  embeds: { label: string; prompt: string; vector: number[] }[];
}

/** Trained linear head over the CLIP image embedding (one row of weights per hazard label). */
export interface HazardHead {
  version: string;
  model: string;
  labels: string[];
  dim: number;
  W: number[][];
  b: number[];
  trained?: Record<string, unknown>;
}

export interface LoadedModels {
  processor: Awaited<ReturnType<TF['AutoProcessor']['from_pretrained']>>;
  vision: Awaited<ReturnType<TF['CLIPVisionModelWithProjection']['from_pretrained']>>;
  detector: (image: unknown, opts: { threshold: number }) => Promise<{ label: string; score: number }[]>;
  text: TextEmbeds;
  head?: HazardHead | null;
  backend: 'webgpu' | 'wasm';
  threads?: number;
}

export async function loadModels(
  tf: TF,
  text: TextEmbeds,
  device: 'webgpu' | 'wasm' | 'cpu',
  progress?: (p: { file?: string; loaded?: number; total?: number; status: string }) => void,
  head?: HazardHead | null,
): Promise<LoadedModels> {
  const opts = { dtype: 'q8' as const, device: device as 'webgpu', progress_callback: progress as never };
  const processor = await tf.AutoProcessor.from_pretrained(CLIP_MODEL);
  const vision = await tf.CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, opts);
  const detector = (await tf.pipeline('object-detection', DETECT_MODEL, opts)) as unknown as LoadedModels['detector'];
  const okHead = head && head.model === CLIP_MODEL && head.W.length === head.labels.length && head.W.every((r) => r.length === head.dim) ? head : null;
  return { processor, vision, detector, text, head: okHead, backend: device === 'webgpu' ? 'webgpu' : 'wasm', threads: tf.env.backends.onnx?.wasm?.numThreads };
}

export async function analyzeImage(m: LoadedModels, image: { width: number; height: number }, now: () => number): Promise<VisionSuggestion> {
  if (image.width > MAX_ANALYSIS_EDGE || image.height > MAX_ANALYSIS_EDGE) {
    throw new Error(`image too large for analysis (${image.width}×${image.height}); downscale first`);
  }
  const t0 = now();
  const inputs = await (m.processor as unknown as (img: unknown) => Promise<Record<string, unknown>>)(image);
  const out = (await (m.vision as unknown as (i: unknown) => Promise<{ image_embeds: { data: Float32Array } }>)(inputs)).image_embeds;
  const v = Array.from(out.data);
  const norm = Math.hypot(...v) || 1;
  const u = v.map((x) => x / norm);
  const names = m.head ? m.head.labels : m.text.embeds.map((e) => e.label);
  const logits = m.head
    ? m.head.W.map((w, k) => w.reduce((s, x, i) => s + x * u[i]!, m.head!.b[k]!))
    : m.text.embeds.map((e) => m.text.logitScale * e.vector.reduce((s, x, i) => s + x * u[i]!, 0));
  const probs = softmax(logits);
  const labels = names
    .map((label, i) => ({ label, score: round3(probs[i]!) }))
    .filter((l) => (HAZARD_LABELS as readonly string[]).includes(l.label))
    .sort((a, b) => b.score - a.score);

  const tClip = now();
  // The detector dominated latency at full size (≈3.4 s of 3.5 s). A people/boat ESTIMATE
  // does not need more than 640 px; this also cuts peak memory on 3 GB phones.
  const big = Math.max(image.width, image.height);
  const detImage =
    big > DETECT_EDGE && typeof (image as { resize?: unknown }).resize === 'function'
      ? await (image as unknown as { resize(w: number, h: number): Promise<unknown> }).resize(
          Math.round((image.width * DETECT_EDGE) / big),
          Math.round((image.height * DETECT_EDGE) / big),
        )
      : image;
  const dets = await m.detector(detImage, { threshold: 0.5 });
  const tDet = now();
  const people = dets.filter((d) => d.label === 'person');
  const boats = dets.filter((d) => d.label === 'boat');
  const mean = (xs: { score: number }[]) => (xs.length ? round3(xs.reduce((s, d) => s + d.score, 0) / xs.length) : 0);

  return {
    labels,
    personCount: { estimate: people.length, confidence: people.length ? mean(people) : round3(1 - (dets[0]?.score ?? 0) * 0.5) },
    boatCount: { estimate: boats.length, confidence: boats.length ? mean(boats) : 0.5 },
    hazards: hazardsFromLabels(labels),
    model: `${CLIP_MODEL} (q8)${m.head ? ` + trained head ${m.head.version}` : ' zero-shot'} + ${DETECT_MODEL} (q8)`,
    version: VISION_VERSION,
    latencyMs: Math.round(now() - t0),
    backend: m.backend,
    timings: { clipMs: Math.round(tClip - t0), detectMs: Math.round(tDet - tClip), threads: m.threads },
  };
}

/**
 * Deterministic MOCK analyser – used only when explicitly enabled (tests /
 * demo) and always labelled backend:'mock'. Derives a label from mean colour.
 */
export function mockAnalyze(rgbaMean: [number, number, number], now: () => number): VisionSuggestion {
  const [r, g, b] = rgbaMean;
  const t0 = now();
  let top: (typeof HAZARD_LABELS)[number] = 'normal street';
  if (b > r + 20 && b > g) top = 'flooded street';
  else if (r > g + 40 && r > b + 40) top = 'fire or smoke';
  else if (g > r && g > b) top = 'landslide debris';
  else if (r + g + b < 150) top = 'collapsed building';
  const labels = HAZARD_LABELS.map((l) => ({ label: l, score: l === top ? 0.62 : round3(0.38 / (HAZARD_LABELS.length - 1)) })).sort((a, b) => b.score - a.score);
  return {
    labels,
    personCount: { estimate: 0, confidence: 0.5 },
    hazards: hazardsFromLabels(labels),
    model: 'MOCK (deterministic colour heuristic – not a real model)',
    version: 'mock-1',
    latencyMs: Math.round(now() - t0),
    backend: 'mock',
  };
}

function softmax(xs: number[]): number[] {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
