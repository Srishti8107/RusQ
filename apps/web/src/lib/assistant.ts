/**
 * OPTIONAL AI writing helper (Phase 2, §4/§10.7). EXPERIMENTAL, OFF by default.
 *
 * Rules (enforced here + in packages/shared/src/assist.ts):
 *  - it never calculates or changes an allotment or any number: every reply is
 *    schema-validated and REJECTED if it contains a number that is not in the input;
 *  - the deterministic template text is always available and is what the app
 *    uses when the helper is off, missing, too slow, or its reply fails the guard;
 *  - low-power mode never loads it.
 */
import {
  allotmentNumbers,
  guardExplanation,
  guardStructuredNotes,
  HAZARD_LABELS,
  RESOURCE_KEYS,
  templateExplanation,
  type AllocationResult,
  type ResourceQty,
  type StructuredNotes,
} from '@rusq/shared';
import { getSettings } from './session.ts';

export const LLM_DOWNLOAD_MB = 880;

export type AssistStatus = 'off' | 'unsupported' | 'not-loaded' | 'loading' | 'ready' | 'error';

let worker: Worker | null = null;
let status: AssistStatus = 'not-loaded';
let lastError = '';
let progressText = '';
let seq = 0;
const pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function onAssistChange(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function assistState() {
  return { status, lastError, progressText };
}

/** WebGPU present AND an adapter is available (the 1B model needs it). */
export async function assistSupported(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

export async function assistEnabled(): Promise<boolean> {
  const s = await getSettings();
  return s.assistant && !s.lowPower;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/llm.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ type: string; id?: number; text?: string; message?: string; progress?: number }>) => {
    const m = e.data;
    if (m.type === 'progress') {
      progressText = m.text ?? '';
      emit();
    } else if (m.type === 'loaded') {
      status = 'ready';
      emit();
    } else if (m.type === 'reply' && m.id !== undefined) {
      pending.get(m.id)?.resolve(m.text ?? '');
      pending.delete(m.id);
    } else if (m.type === 'error') {
      if (m.id !== undefined) {
        pending.get(m.id)?.reject(new Error(m.message));
        pending.delete(m.id);
      } else {
        status = 'error';
        lastError = m.message ?? 'unknown error';
        emit();
      }
    }
  };
  return worker;
}

/** Downloads (first time, needs internet) and loads the model. */
export async function loadAssistant(): Promise<void> {
  if (!(await assistSupported())) {
    status = 'unsupported';
    emit();
    return;
  }
  status = 'loading';
  lastError = '';
  emit();
  ensureWorker().postMessage({ type: 'load' });
}

export function unloadAssistant() {
  worker?.terminate();
  worker = null;
  status = 'not-loaded';
  emit();
}

function ask(system: string, user: string, json: boolean, timeoutMs = 60_000): Promise<string> {
  if (status !== 'ready' || !worker) return Promise.reject(new Error('the helper is not loaded'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ type: 'chat', id, system, user, json });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('the helper took too long'));
    }, timeoutMs);
  });
}

export async function structureNotes(notes: string): Promise<{ ok: true; value: StructuredNotes } | { ok: false; reason: string }> {
  const system = [
    'You turn a rescuer’s field notes into JSON. Output ONLY a JSON object with keys:',
    '"observations": array of short sentences copied or shortened from the notes,',
    `"hazardsMentioned": subset of ${JSON.stringify(HAZARD_LABELS)},`,
    `"needsMentioned": subset of ${JSON.stringify(RESOURCE_KEYS)}.`,
    'Never invent facts. Never write any number that is not written in the notes. Copy numbers as digits.',
  ].join(' ');
  try {
    return guardStructuredNotes(await ask(system, notes, true), notes);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/**
 * Plain-language explanation of a provisional share. Always returns usable
 * text: the helper's wording if it passed the guard, otherwise the template.
 */
export async function explainShare(result: AllocationResult, siteId: string, requested: ResourceQty): Promise<{ text: string; source: 'assistant' | 'template'; discarded?: string }> {
  const template = templateExplanation(result, siteId, requested);
  if (!(await assistEnabled()) || status !== 'ready') return { text: template, source: 'template' };
  const system =
    'Rewrite the explanation below in very simple, kind language for a tired rescuer (max 4 sentences). Return JSON {"text": "..."}. Keep every number exactly as written; do not add, compute or change any number.';
  try {
    const g = guardExplanation(await ask(system, template, true), allotmentNumbers(result, siteId, requested));
    return g.ok ? { text: g.value.text, source: 'assistant' } : { text: template, source: 'template', discarded: g.reason };
  } catch (e) {
    return { text: template, source: 'template', discarded: (e as Error).message };
  }
}
