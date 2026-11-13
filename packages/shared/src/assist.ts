/**
 * Guard rails for the OPTIONAL on-device language-model assistant (§4, §10.7).
 *
 * The model may only (a) restructure a rescuer's free-text notes and
 * (b) re-word an allotment explanation in plain language. It must never
 * produce or change a number. Every output passes through these validators:
 *   1. it must match a strict schema (zod), and
 *   2. every number in the output must already appear in the input.
 * If either check fails the app discards the output and shows the
 * deterministic template text instead – the app works identically without it.
 */
import { z } from 'zod';
import { HAZARD_LABELS, RESOURCE_KEYS, RESOURCES, type ResourceKey, type ResourceQty } from './resources.ts';
import type { AllocationResult } from './allocation/engine.ts';

export const StructuredNotes = z.object({
  observations: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  hazardsMentioned: z.array(z.enum(HAZARD_LABELS)).max(HAZARD_LABELS.length).default([]),
  needsMentioned: z.array(z.enum(RESOURCE_KEYS)).max(RESOURCE_KEYS.length).default([]),
});
export type StructuredNotes = z.infer<typeof StructuredNotes>;

export const PlainExplanation = z.object({ text: z.string().trim().min(10).max(1200) });

/** All numbers in a text, normalised ("1,200" → "1200", "3.50" → "3.5"). */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => String(Number(n.replace(/,/g, ''))));
}

const NUMBER_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|dozen|half|double|twice|triple)\b/i;

export type GuardResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function checkNumbers(outputText: string, allowed: Set<string>): string | null {
  for (const n of numbersIn(outputText)) if (!allowed.has(n)) return `the assistant wrote the number ${n}, which is not in the input`;
  if (NUMBER_WORDS.test(outputText)) return 'the assistant wrote a number in words; numbers may only be copied as digits';
  return null;
}

function parseJson(raw: string): unknown {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in the output');
  return JSON.parse(m[0]);
}

export function guardStructuredNotes(raw: string, sourceNotes: string): GuardResult<StructuredNotes> {
  let obj: unknown;
  try {
    obj = parseJson(raw);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const p = StructuredNotes.safeParse(obj);
  if (!p.success) return { ok: false, reason: `schema: ${p.error.issues[0]?.path.join('.')} ${p.error.issues[0]?.message}` };
  const bad = checkNumbers(p.data.observations.join(' '), new Set(numbersIn(sourceNotes)));
  return bad ? { ok: false, reason: bad } : { ok: true, value: p.data };
}

/** The numbers an allotment explanation may mention. */
export function allotmentNumbers(a: Pick<AllocationResult, 'perSite' | 'shortfall' | 'explanation' | 'snapshotVersion'>, siteId: string, requested: ResourceQty = {}): Set<string> {
  const s = new Set<string>([String(a.snapshotVersion)]);
  const add = (n: number | undefined) => n !== undefined && s.add(String(n));
  for (const q of Object.values(requested)) add(q);
  for (const q of Object.values(a.perSite[siteId] ?? {})) add(q);
  for (const q of Object.values(a.shortfall)) add(q);
  for (const r of Object.values(a.explanation.resources)) {
    if (!r) continue;
    add(r.stock);
    add(r.totalNeed);
    for (const w of r.weights) if (w.siteId === siteId) add(w.need);
  }
  const me = a.explanation.sites.find((x) => x.id === siteId);
  if (me) add(me.density), add(me.urgency);
  for (const n of ['1', '2', '3', '4', '5']) s.add(n); // urgency scale words like "level 5 of 5"
  return s;
}

export function guardExplanation(raw: string, allowed: Set<string>): GuardResult<{ text: string }> {
  let obj: unknown;
  try {
    obj = parseJson(raw);
  } catch {
    obj = { text: raw };
  }
  const p = PlainExplanation.safeParse(obj);
  if (!p.success) return { ok: false, reason: `schema: ${p.error.issues[0]?.message}` };
  const bad = checkNumbers(p.data.text, allowed);
  return bad ? { ok: false, reason: bad } : { ok: true, value: p.data };
}

/**
 * Deterministic plain-language explanation – ALWAYS available, used when the
 * assistant is off, missing, or its output fails the guard.
 */
export function templateExplanation(
  a: Pick<AllocationResult, 'perSite' | 'shortfall' | 'explanation' | 'snapshotVersion'>,
  siteId: string,
  /** what this site asked for (the engine's explanation keeps per-site needs only in weighted mode) */
  requested: ResourceQty = {},
): string {
  const mine = a.perSite[siteId] ?? {};
  const lines: string[] = [];
  for (const k of RESOURCE_KEYS) {
    const r = a.explanation.resources[k];
    const got = mine[k as ResourceKey] ?? 0;
    const need = requested[k] ?? r?.weights.find((x) => x.siteId === siteId)?.need ?? (r?.mode === 'full' ? got : 0);
    if (!r || r.totalNeed === 0 || need === 0) continue;
    const label = RESOURCES[k].label.toLowerCase();
    const unit = RESOURCES[k].unit;
    if (r.mode === 'full') lines.push(`You asked for ${need} ${unit} of ${label}. There is enough stock (${r.stock}) for every site, so you get all ${got}.`);
    else if (r.mode === 'none') lines.push(`You asked for ${need} ${unit} of ${label}, but there is none left in stock, so you get ${got} for now.`);
    else
      lines.push(
        `You asked for ${need} ${unit} of ${label}, but all sites together asked for ${r.totalNeed} and only ${r.stock} are in stock. Sites with more people and higher urgency get a larger share, so your fair share is ${got}.`,
      );
  }
  if (!lines.length) return 'Nothing was requested for this site.';
  return `${lines.join(' ')} This is a provisional share based on snapshot version ${a.snapshotVersion}; the control room makes the final decision.`;
}
