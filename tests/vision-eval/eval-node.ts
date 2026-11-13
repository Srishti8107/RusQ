/**
 * Vision evaluation (§9) – Node runner. Uses the SAME vision-core.ts the app
 * ships, with transformers.js on onnxruntime-node (CPU). Browser/WASM latency is
 * measured separately by the Playwright vision test.
 *
 *   npx tsx tests/vision-eval/eval-node.ts
 *
 * Writes docs/vision-eval.json. Targets are REPORTED, not tuned for:
 *   top hazard correct ≥ 70 %   ·   warm analysis ≤ 5 s
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HAZARD_LABELS } from '@rusq/shared';
import { analyzeImage, loadModels, type TextEmbeds } from '../../apps/web/src/lib/vision-core.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FIX = join(ROOT, 'tests/fixtures/vision');
const MODELS = join(ROOT, 'apps/web/public/models');

let peakRss = 0;
const sample = () => (peakRss = Math.max(peakRss, process.memoryUsage().rss));
const memTimer = setInterval(sample, 50);

const tf = await import('@huggingface/transformers');
tf.env.allowRemoteModels = false;
tf.env.allowLocalModels = true;
tf.env.localModelPath = MODELS + '/';

const text = JSON.parse(readFileSync(join(MODELS, 'clip-text-embeds.json'), 'utf8')) as TextEmbeds;
const labels = JSON.parse(readFileSync(join(FIX, 'LABELS.json'), 'utf8')) as { file: string; label: string }[];

const tLoad = performance.now();
const models = await loadModels(tf, text, 'cpu');
const loadMs = performance.now() - tLoad;

interface Row {
  file: string;
  truth: string;
  top: string;
  topScore: number;
  hazards: string[];
  ms: number;
  people: number;
}
const rows: Row[] = [];
for (let i = 0; i < labels.length; i++) {
  const l = labels[i]!;
  const img = await tf.RawImage.read(join(FIX, l.file));
  const r = await analyzeImage(models, img, () => performance.now());
  sample();
  rows.push({ file: l.file, truth: l.label, top: r.labels[0]!.label, topScore: r.labels[0]!.score, hazards: r.hazards, ms: r.latencyMs, people: r.personCount?.estimate ?? 0 });
  process.stdout.write(`${i + 1}/${labels.length} ${l.label.padEnd(26)} → ${r.labels[0]!.label} (${r.labels[0]!.score}) ${r.latencyMs} ms\n`);
}
clearInterval(memTimer);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

const perLabel = HAZARD_LABELS.map((label) => {
  const tp = rows.filter((r) => r.truth === label && r.top === label).length;
  const fp = rows.filter((r) => r.truth !== label && r.top === label).length;
  const fn = rows.filter((r) => r.truth === label && r.top !== label).length;
  return {
    label,
    support: rows.filter((r) => r.truth === label).length,
    precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null,
    recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null,
  };
});
const correct = rows.filter((r) => r.top === r.truth).length;
const hazardRows = rows.filter((r) => r.truth !== 'normal street');
const tagRecall = hazardRows.filter((r) => r.hazards.includes(r.truth)).length / hazardRows.length;

const result = {
  runner: 'node (onnxruntime-node CPU) – same vision-core.ts as the app',
  date: new Date().toISOString(),
  fixtures: rows.length,
  models: models ? 'Xenova/clip-vit-base-patch32 vision (q8) + precomputed text embeds; Xenova/yolos-tiny (q8)' : '',
  topHazardAccuracy: +(correct / rows.length).toFixed(3),
  target: { topHazardAccuracy: 0.7, warmLatencyMs: 5000 },
  hazardTagRecall: +tagRecall.toFixed(3),
  coldMs: { modelLoad: Math.round(loadMs), firstAnalysis: rows[0]!.ms },
  warmMedianMs: median(rows.slice(1).map((r) => r.ms)),
  warmP90Ms: [...rows.slice(1).map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(0.9 * (rows.length - 1))],
  peakRssMB: Math.round(peakRss / 1048576),
  perLabel,
  confusion: rows.filter((r) => r.top !== r.truth).map((r) => ({ file: r.file, truth: r.truth, predicted: r.top, score: r.topScore })),
};
mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(join(ROOT, 'docs/vision-eval.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, confusion: `${result.confusion.length} misses` }, null, 2));
