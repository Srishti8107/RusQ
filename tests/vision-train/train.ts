/**
 * Trains the hazard classification HEAD on top of the app's frozen CLIP ViT-B/32 vision tower.
 *
 *   npx tsx tests/vision-train/train.ts            (after fetch.mjs + review)
 *
 * 1. Image features: CLIP image embedding of every REVIEWED training image, plus CCTV-style
 *    variants (low resolution + heavy JPEG, blur, sodium-light colour cast, dusk, night/IR grey,
 *    crop) – the same q8 vision model the phones run, so features match the app exactly.
 * 2. Start point: zero-shot weights from an ENSEMBLE of CLIP text prompts per label.
 * 3. Training: multinomial logistic regression (softmax), class-balanced, L2 pull towards the
 *    zero-shot start (so little data cannot drag it far), λ chosen on a validation split.
 * 4. Test: groups (one photo, or all frames of one video) are split train / val / test, so no
 *    frame of a test video was seen in training. Also tested on the 52 fixture photos, which are
 *    never used for training (different source, Openverse).
 *
 * Writes apps/web/src/lib/hazard-head.json (shipped) and docs/vision-train.json (report).
 * Training images stay in data/vision-train (not in git).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { HAZARD_LABELS } from '@rusq/shared';

const ROOT = resolve(import.meta.dirname, '../..');
const MODELS = join(ROOT, 'apps/web/public/models');
const BUILD_CACHE = join(ROOT, 'apps/web/.model-cache');
const DATA = join(ROOT, 'data/vision-train');
const CACHE = join(DATA, 'embeds-cache.json');
const CLIP = 'Xenova/clip-vit-base-patch32';
const LABELS = [...HAZARD_LABELS];
const K = LABELS.length;

/** Prompt ensemble per label (zero-shot start point). */
const PROMPTS: Record<string, string[]> = {
  'flooded street': [
    'a photo of a flooded street',
    'muddy brown flood water covering a road and houses',
    'a flooded town in Nepal during the monsoon',
    'a CCTV camera frame of a flooded street',
    'a still from a video of a flood with fast flowing water',
    'people wading through flood water in a street',
  ],
  'collapsed building': ['a photo of a collapsed building', 'rubble of a house destroyed by an earthquake', 'a pancaked concrete building after an earthquake'],
  'blocked road': ['a photo of a road blocked by fallen trees or debris', 'a fallen tree lying across a road', 'debris blocking a street'],
  'fire or smoke': [
    'a photo of fire or smoke',
    'a building on fire with orange flames',
    'thick black smoke rising from a fire',
    'a CCTV camera frame of a fire',
    'firefighters spraying water on a burning house',
  ],
  'landslide debris': ['a photo of landslide debris and mud', 'a landslide covering a mountain road in Nepal', 'a hillside collapsed into mud and rocks'],
  'damaged bridge': ['a photo of a damaged bridge', 'a collapsed bridge over a river', 'a bridge washed away by a flood'],
  'people waiting for rescue': ['a photo of people waiting for rescue', 'flood victims being rescued by boat', 'people stranded on a roof waiting for help'],
  'normal street': [
    'a photo of a normal street',
    'a busy street in Kathmandu with traffic',
    'a wet street after rain with puddles',
    'a CCTV camera view of a normal street',
    'a quiet residential lane',
  ],
};

type Aug = 'orig' | 'cctv' | 'blur' | 'sodium' | 'dusk' | 'ir' | 'crop';
const AUGS: Aug[] = ['orig', 'cctv', 'blur', 'sodium', 'dusk', 'ir', 'crop'];

async function augment(file: string, a: Aug): Promise<Buffer> {
  const img = sharp(file).rotate();
  const meta = await img.metadata();
  const w = meta.width ?? 640;
  const h = meta.height ?? 480;
  switch (a) {
    case 'orig':
      return img.jpeg({ quality: 90 }).toBuffer();
    case 'cctv': // 352-px stream, heavy compression, back up to normal size
      return sharp(await img.resize(352).jpeg({ quality: 18 }).toBuffer()).resize(704).jpeg({ quality: 70 }).toBuffer();
    case 'blur':
      return img.blur(2.2).jpeg({ quality: 60 }).toBuffer();
    case 'sodium': // street-light orange cast – the case that looked like fire
      return img.modulate({ saturation: 0.6, brightness: 0.85 }).tint({ r: 255, g: 170, b: 90 }).jpeg({ quality: 55 }).toBuffer();
    case 'dusk':
      return img.modulate({ brightness: 0.45, saturation: 0.7 }).jpeg({ quality: 55 }).toBuffer();
    case 'ir': // night / infra-red CCTV: grey, contrasty, noisy-ish (via down-up scaling)
      return sharp(await img.grayscale().linear(1.4, -30).resize(320).jpeg({ quality: 30 }).toBuffer()).resize(640).toBuffer();
    case 'crop': {
      const cw = Math.round(w * 0.7);
      const ch = Math.round(h * 0.7);
      return img.extract({ left: Math.round((w - cw) / 2), top: Math.round((h - ch) * 0.6), width: cw, height: ch }).jpeg({ quality: 75 }).toBuffer();
    }
  }
}

const unit = (v: number[]) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
function softmax(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}
const hashFrac = (s: string) => parseInt(createHash('sha1').update(s).digest('hex').slice(0, 8), 16) / 0xffffffff;

/* ----------------------------------- models ----------------------------------- */

const tf = await import('@huggingface/transformers');
tf.env.allowRemoteModels = false;
tf.env.allowLocalModels = true;

tf.env.localModelPath = BUILD_CACHE + '/';
const tokenizer = await tf.AutoTokenizer.from_pretrained(CLIP);
const textModel = await tf.CLIPTextModelWithProjection.from_pretrained(CLIP, { dtype: 'fp32' });
async function textVec(prompts: string[]): Promise<number[]> {
  const inputs = tokenizer(prompts, { padding: true, truncation: true });
  const { text_embeds } = (await textModel(inputs)) as { text_embeds: { data: Float32Array; dims: number[] } };
  const d = text_embeds.dims[1]!;
  const mean = new Array(d).fill(0);
  for (let i = 0; i < prompts.length; i++) {
    const v = unit(Array.from(text_embeds.data.slice(i * d, (i + 1) * d)));
    v.forEach((x, j) => (mean[j] += x / prompts.length));
  }
  return unit(mean);
}

tf.env.localModelPath = MODELS + '/';
const processor = await tf.AutoProcessor.from_pretrained(CLIP);
const vision = await tf.CLIPVisionModelWithProjection.from_pretrained(CLIP, { dtype: 'q8', device: 'cpu' });
async function imageVec(buf: Buffer): Promise<number[]> {
  const img = await tf.RawImage.fromBlob(new Blob([buf]));
  const inputs = await (processor as unknown as (i: unknown) => Promise<unknown>)(img);
  const out = (await (vision as unknown as (i: unknown) => Promise<{ image_embeds: { data: Float32Array } }>)(inputs)).image_embeds;
  return unit(Array.from(out.data));
}

/* ------------------------------------ data ------------------------------------ */

interface Item {
  id: string;
  label: string;
  file: string;
  group: string;
  kind: string;
  status: string;
}
const dataset = (JSON.parse(readFileSync(join(ROOT, 'tests/vision-train/dataset.json'), 'utf8')) as Item[]).filter((x) => x.status === 'accepted' && LABELS.includes(x.label as never));
if (dataset.length < 100) throw new Error(`only ${dataset.length} reviewed (accepted) images – review first`);

const cache: Record<string, number[]> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
let fresh = 0;
for (const [i, it] of dataset.entries()) {
  for (const a of AUGS) {
    const key = `${it.id}|${a}`;
    if (cache[key]) continue;
    try {
      cache[key] = (await imageVec(await augment(join(ROOT, it.file), a))).map((x) => +x.toFixed(5));
      fresh++;
    } catch (e) {
      console.log('skip', it.id, a, (e as Error).message);
    }
  }
  if (i % 25 === 0) {
    console.log(`features ${i + 1}/${dataset.length}`);
    mkdirSync(DATA, { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache));
  }
}
writeFileSync(CACHE, JSON.stringify(cache));
console.log('new feature vectors', fresh);

// Split by group: 70 % train, 10 % validation, 20 % test (stable hash, stratified by label).
const split = (it: Item) => {
  const f = hashFrac(`${it.label}|${it.group}`);
  return f < 0.7 ? 'train' : f < 0.8 ? 'val' : 'test';
};
type Row = { x: number[]; y: number; id: string; aug: Aug; kind: string };
const rows = (part: string, augs: Aug[]) =>
  dataset
    .filter((it) => split(it) === part)
    .flatMap((it) => augs.filter((a) => cache[`${it.id}|${a}`]).map((a) => ({ x: cache[`${it.id}|${a}`]!, y: LABELS.indexOf(it.label as never), id: it.id, aug: a, kind: it.kind })));

const train = rows('train', AUGS);
const val = rows('val', AUGS);
const test = rows('test', AUGS);

/* --------------------------------- zero-shot start -------------------------------- */

const SCALE = 100;
const W0: number[][] = [];
for (const l of LABELS) W0.push((await textVec(PROMPTS[l]!)).map((x) => x * SCALE));
const b0 = new Array(K).fill(0);

/* ------------------------------------- training ------------------------------------ */

function fit(data: Row[], lambda: number, epochs = 400, lr = 0.5) {
  const W = W0.map((r) => [...r]);
  const b = [...b0];
  const count = new Array(K).fill(0);
  for (const r of data) count[r.y]++;
  const cw = count.map((c) => (c ? data.length / (K * c) : 0)); // class balance
  const n = data.length;
  for (let ep = 0; ep < epochs; ep++) {
    const gW = W.map((r) => r.map(() => 0));
    const gb = new Array(K).fill(0);
    for (const r of data) {
      const p = softmax(W.map((w, k) => dot(w, r.x) + b[k]!));
      for (let k = 0; k < K; k++) {
        const g = (cw[r.y]! * (p[k]! - (k === r.y ? 1 : 0))) / n;
        gb[k] += g;
        const row = gW[k]!;
        for (let j = 0; j < r.x.length; j++) row[j] += g * r.x[j]!;
      }
    }
    for (let k = 0; k < K; k++) {
      b[k] -= lr * gb[k]!;
      for (let j = 0; j < W[k]!.length; j++) W[k]![j] -= lr * (gW[k]![j]! + lambda * (W[k]![j]! - W0[k]![j]!));
    }
  }
  return { W, b };
}

const predict = (m: { W: number[][]; b: number[] }, x: number[]) => softmax(m.W.map((w, k) => dot(w, x) + m.b[k]!));
const argmax = (p: number[]) => p.indexOf(Math.max(...p));
function evaluate(m: { W: number[][]; b: number[] }, data: { x: number[]; y: number }[]) {
  const conf = LABELS.map(() => new Array(K).fill(0));
  for (const r of data) conf[r.y]![argmax(predict(m, r.x))]++;
  const correct = conf.reduce((s, row, i) => s + row[i]!, 0);
  return {
    n: data.length,
    accuracy: data.length ? +(correct / data.length).toFixed(3) : null,
    perLabel: LABELS.map((l, i) => {
      const tp = conf[i]![i]!;
      const sup = conf[i]!.reduce((a, b) => a + b, 0);
      const pred = conf.reduce((s, row) => s + row[i]!, 0);
      return { label: l, support: sup, recall: sup ? +(tp / sup).toFixed(3) : null, precision: pred ? +(tp / pred).toFixed(3) : null };
    }),
    floodAsFire: conf[LABELS.indexOf('flooded street')]![LABELS.indexOf('fire or smoke')],
    confusion: conf,
  };
}

const zeroShot = { W: W0, b: b0 };
const single = { W: (JSON.parse(readFileSync(join(MODELS, 'clip-text-embeds.json'), 'utf8')) as { embeds: { label: string; vector: number[] }[] }).embeds.map((e) => e.vector.map((x) => x * SCALE)), b: b0 };

let best = { lambda: 0, acc: -1, model: zeroShot };
for (const lambda of [0.3, 0.1, 0.03, 0.01, 0.003]) {
  const m = fit(train, lambda);
  const acc = evaluate(m, val).accuracy ?? 0;
  console.log(`λ=${lambda} validation accuracy ${acc}`);
  if (acc > best.acc) best = { lambda, acc, model: m };
}
// Final model: train + validation with the chosen λ.
const final = fit([...train, ...val], best.lambda);

/* ---------------------------------- external test ---------------------------------- */

const FIX = join(ROOT, 'tests/fixtures/vision');
const fixtures = JSON.parse(readFileSync(join(FIX, 'LABELS.json'), 'utf8')) as { file: string; label: string }[];
const fixRows: { x: number[]; y: number; aug: Aug }[] = [];
for (const f of fixtures) {
  for (const a of ['orig', 'cctv', 'sodium', 'ir'] as Aug[]) {
    const key = `fixture:${f.file}|${a}`;
    cache[key] ??= (await imageVec(await augment(join(FIX, f.file), a))).map((x) => +x.toFixed(5));
    fixRows.push({ x: cache[key]!, y: LABELS.indexOf(f.label as never), aug: a });
  }
}
writeFileSync(CACHE, JSON.stringify(cache));

const report = (m: { W: number[][]; b: number[] }) => ({
  heldOutTest: evaluate(m, test.filter((r) => r.aug === 'orig')),
  heldOutTestCctvVariants: evaluate(m, test.filter((r) => r.aug !== 'orig')),
  heldOutVideoFrames: evaluate(m, test.filter((r) => r.kind === 'video-frame')),
  fixtures52: evaluate(m, fixRows.filter((r) => r.aug === 'orig')),
  fixtures52CctvVariants: evaluate(m, fixRows.filter((r) => r.aug !== 'orig')),
});

const counts = Object.fromEntries(LABELS.map((l) => [l, { images: dataset.filter((d) => d.label === l).length, videoFrames: dataset.filter((d) => d.label === l && d.kind === 'video-frame').length }]));
const result = {
  date: new Date().toISOString(),
  model: `${CLIP} vision tower (q8, frozen) + trained linear head`,
  data: { reviewedImages: dataset.length, perLabel: counts, augmentations: AUGS, split: '70/10/20 by source group (photo or whole video)', trainRows: train.length, valRows: val.length, testRows: test.length },
  lambda: best.lambda,
  before_singlePromptZeroShot: report(single),
  before_promptEnsembleZeroShot: report(zeroShot),
  after_trainedHead: report(final),
};
mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(join(ROOT, 'docs/vision-train.json'), JSON.stringify(result, null, 1));

const head = {
  version: `hazard-head-${result.date.slice(0, 10)}`,
  model: CLIP,
  labels: LABELS,
  dim: final.W[0]!.length,
  W: final.W.map((r) => r.map((x) => +x.toFixed(4))),
  b: final.b.map((x) => +x.toFixed(4)),
  trained: { images: dataset.length, lambda: best.lambda, testAccuracy: result.after_trainedHead.heldOutTest.accuracy, cctvTestAccuracy: result.after_trainedHead.heldOutTestCctvVariants.accuracy },
};
writeFileSync(join(ROOT, 'apps/web/src/lib/hazard-head.json'), JSON.stringify(head));

const line = (name: string, r: ReturnType<typeof report>) =>
  console.log(
    `${name.padEnd(30)} test ${r.heldOutTest.accuracy} · test CCTV-style ${r.heldOutTestCctvVariants.accuracy} · video frames ${r.heldOutVideoFrames.accuracy} · fixtures ${r.fixtures52.accuracy} · fixtures CCTV-style ${r.fixtures52CctvVariants.accuracy} · flood→fire (test+cctv) ${r.heldOutTest.floodAsFire + r.heldOutTestCctvVariants.floodAsFire}`,
  );
line('zero-shot (1 prompt, shipped)', result.before_singlePromptZeroShot);
line('zero-shot (prompt ensemble)', result.before_promptEnsembleZeroShot);
line('trained head', result.after_trainedHead);
