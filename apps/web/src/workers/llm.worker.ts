/// <reference lib="webworker" />
/**
 * OPTIONAL on-device language model (Phase 2, §10.7) – EXPERIMENTAL, off by default.
 * Llama 3.2 1B (q4f16, MLC build) via WebLLM on WebGPU, in a Web Worker so the
 * UI never blocks. The worker only turns text into text; the main thread runs
 * every reply through the shared guard (schema + "no new numbers") before use.
 *
 * This chunk is NOT precached (it is several MB). It is downloaded only when a
 * user switches the helper on, then kept by the service worker for offline use.
 */
import { CreateMLCEngine, type MLCEngine } from '@mlc-ai/web-llm';

export const LLM_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

let engine: MLCEngine | null = null;

type In = { type: 'load' } | { type: 'chat'; id: number; system: string; user: string; json: boolean } | { type: 'unload' };

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      if (!engine) {
        engine = await CreateMLCEngine(LLM_MODEL, {
          initProgressCallback: (p) => postMessage({ type: 'progress', text: p.text, progress: p.progress }),
        });
      }
      postMessage({ type: 'loaded' });
    } else if (m.type === 'chat') {
      if (!engine) throw new Error('model not loaded');
      const r = await engine.chat.completions.create({
        messages: [
          { role: 'system', content: m.system },
          { role: 'user', content: m.user },
        ],
        temperature: 0,
        max_tokens: 400,
        ...(m.json ? { response_format: { type: 'json_object' as const } } : {}),
      });
      postMessage({ type: 'reply', id: m.id, text: r.choices[0]?.message.content ?? '' });
    } else if (m.type === 'unload') {
      await engine?.unload();
      engine = null;
      postMessage({ type: 'unloaded' });
    }
  } catch (err) {
    postMessage({ type: 'error', id: (m as { id?: number }).id, message: (err as Error).message });
  }
};
