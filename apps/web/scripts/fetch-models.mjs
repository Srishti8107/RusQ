/**
 * Downloads the on-device vision models into apps/web/public/models/ so the app
 * SELF-HOSTS them (no runtime dependency on Hugging Face; phones fetch them from
 * our own origin during the "Ready for offline" setup, then work offline).
 *
 * Also precomputes CLIP TEXT embeddings for the fixed hazard prompts, so phones
 * only need the CLIP *vision* tower (85 MB) – not the text tower (61–242 MB).
 *
 *   node apps/web/scripts/fetch-models.mjs
 */
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, '../public/models');
const BUILD_CACHE = resolve(here, '../.model-cache'); // build-only files, never served
const HF = 'https://huggingface.co';

export const CLIP = 'Xenova/clip-vit-base-patch32';
export const DETR = 'Xenova/yolos-tiny';

const SERVED = {
  [CLIP]: ['config.json', 'preprocessor_config.json', 'onnx/vision_model_quantized.onnx'],
  [DETR]: ['config.json', 'preprocessor_config.json', 'onnx/model_quantized.onnx'],
};
const BUILD_ONLY = {
  [CLIP]: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/text_model.onnx'],
};

async function download(model, file, root) {
  const out = join(root, model, file);
  if (existsSync(out) && statSync(out).size > 0) return out;
  mkdirSync(dirname(out), { recursive: true });
  const res = await fetch(`${HF}/${model}/resolve/main/${file}`);
  if (!res.ok) throw new Error(`${model}/${file}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
  console.log(`  ${model}/${file}  ${(statSync(out).size / 1048576).toFixed(1)} MB`);
  return out;
}

const PROMPTS = {
  'flooded street': 'a photo of a flooded street',
  'collapsed building': 'a photo of a collapsed building',
  'blocked road': 'a photo of a road blocked by fallen trees or debris',
  'fire or smoke': 'a photo of fire or smoke',
  'landslide debris': 'a photo of landslide debris and mud',
  'damaged bridge': 'a photo of a damaged bridge',
  'people waiting for rescue': 'a photo of people waiting for rescue',
  'normal street': 'a photo of a normal street',
};

async function textEmbeddings() {
  const { env, AutoTokenizer, CLIPTextModelWithProjection } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.localModelPath = BUILD_CACHE + '/';
  const tokenizer = await AutoTokenizer.from_pretrained(CLIP);
  const model = await CLIPTextModelWithProjection.from_pretrained(CLIP, { dtype: 'fp32' });
  const labels = Object.keys(PROMPTS);
  const inputs = tokenizer(labels.map((l) => PROMPTS[l]), { padding: true, truncation: true });
  const { text_embeds } = await model(inputs);
  const dim = text_embeds.dims[1];
  const data = Array.from(text_embeds.data);
  const embeds = labels.map((l, i) => {
    const v = data.slice(i * dim, (i + 1) * dim);
    const n = Math.hypot(...v);
    return { label: l, prompt: PROMPTS[l], vector: v.map((x) => +(x / n).toFixed(6)) };
  });
  const out = join(PUBLIC, 'clip-text-embeds.json');
  writeFileSync(out, JSON.stringify({ model: CLIP, logitScale: 100, dim, embeds }));
  console.log(`  wrote ${out}`);
}

console.log('Downloading served models →', PUBLIC);
for (const [m, files] of Object.entries(SERVED)) for (const f of files) await download(m, f, PUBLIC);
console.log('Downloading build-only files →', BUILD_CACHE);
for (const [m, files] of Object.entries(BUILD_ONLY)) for (const f of files) await download(m, f, BUILD_CACHE);
await textEmbeddings();

// Speed/memory on low-end phones: YOLOS would upscale to a 512 px shortest edge (up to
// 1333 px long). For a people/boat ESTIMATE we cap it at 384/640 (≈2–3× fewer patches).
{
  const { readFileSync } = await import('node:fs');
  const p = join(PUBLIC, DETR, 'preprocessor_config.json');
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  cfg.size = { shortest_edge: 384, longest_edge: 640 };
  cfg._rusq_note = 'size reduced from 512/1333 by RusQ fetch-models.mjs for phone performance';
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  console.log('  patched YOLOS input size → 384/640');
}

const manifest = {
  version: 1,
  models: Object.fromEntries(Object.entries(SERVED).map(([m, fs]) => [m, fs.map((f) => ({ file: f, bytes: statSync(join(PUBLIC, m, f)).size }))])),
  extra: [{ file: 'clip-text-embeds.json', bytes: statSync(join(PUBLIC, 'clip-text-embeds.json')).size }],
};
writeFileSync(join(PUBLIC, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Done. Total served bytes:', (Object.values(manifest.models).flat().concat(manifest.extra).reduce((s, f) => s + f.bytes, 0) / 1048576).toFixed(1), 'MB');
