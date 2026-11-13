/**
 * Vision contract (§8C) shared by the worker, the UI and the evaluation script.
 * The model output is ADVISORY: it only pre-fills an editable suggestion.
 */
import { HAZARD_LABELS, HAZARD_RESOURCE_HINTS, type HazardLabel, type ResourceKey } from './resources.ts';
import type { VisionSuggestion } from './schemas.ts';

/** CLIP prompt text per hazard label (zero-shot classification). */
export const HAZARD_PROMPTS: Record<HazardLabel, string> = {
  'flooded street': 'a photo of a flooded street',
  'collapsed building': 'a photo of a collapsed building',
  'blocked road': 'a photo of a road blocked by fallen trees or debris',
  'fire or smoke': 'a photo of fire or smoke',
  'landslide debris': 'a photo of landslide debris and mud',
  'damaged bridge': 'a photo of a damaged bridge',
  'people waiting for rescue': 'a photo of people waiting for rescue',
  'normal street': 'a photo of a normal street',
};

/** Minimum score for a label to be proposed as a hazard tag. */
export const HAZARD_THRESHOLD = 0.2;

/** Turn ranked labels into proposed hazard tags (never includes 'normal street'). */
export function hazardsFromLabels(labels: { label: string; score: number }[], threshold = HAZARD_THRESHOLD): HazardLabel[] {
  const ranked = [...labels].sort((a, b) => b.score - a.score);
  const out: HazardLabel[] = [];
  for (const l of ranked) {
    if (!(HAZARD_LABELS as readonly string[]).includes(l.label)) continue;
    if (l.label === 'normal street') continue;
    if (l.score >= threshold || (out.length === 0 && l === ranked[0])) out.push(l.label as HazardLabel);
  }
  return out;
}

export function topHazard(s: Pick<VisionSuggestion, 'labels'>): string | null {
  const best = [...s.labels].sort((a, b) => b.score - a.score)[0];
  return best ? best.label : null;
}

/** Checklist HINTS for the given hazard tags (suggestions only – never auto-ticked). */
export function resourceHints(hazards: HazardLabel[]): { resource: ResourceKey; note: string; from: HazardLabel }[] {
  const seen = new Set<string>();
  const out: { resource: ResourceKey; note: string; from: HazardLabel }[] = [];
  for (const h of hazards) {
    for (const hint of HAZARD_RESOURCE_HINTS[h]) {
      const key = `${hint.resource}:${hint.note}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...hint, from: h });
    }
  }
  return out;
}
