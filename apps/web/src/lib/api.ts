/** Thin fetch wrapper: same-origin /api, bearer token, hard timeout. */
import { getSession } from './session.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { timeoutMs?: number; auth?: boolean } = {}): Promise<T> {
  const { timeoutMs = 15_000, auth = true, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (auth) {
    const s = await getSession();
    if (s) headers.set('authorization', `Bearer ${s.token}`);
  }
  if (rest.body && typeof rest.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api${path}`, { ...rest, headers, signal: ctrl.signal, cache: 'no-store' });
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (!res.ok) throw new ApiError(res.status, (body as { error?: string })?.error ?? res.statusText);
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, (e as Error).name === 'AbortError' ? 'timed out' : 'network unreachable');
  } finally {
    clearTimeout(t);
  }
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return { error: t.slice(0, 200) };
  }
}
