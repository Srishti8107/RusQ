/**
 * Thin fetch wrapper: same-origin /api, bearer token, hard timeout.
 *
 * Only JSON answers count as "the server answered". A proxy or HTTPS tunnel that cannot reach
 * the server returns an HTML error page ("<!DOCTYPE html>…", HTTP 502/530…). That used to be
 * shown raw in a red box (decisions.md 12.3). Now it is treated like "no connection":
 * friendly text, the saved copy is used, and the sync engine simply retries.
 */
import { getSession } from './session.ts';
import { apiUrl } from './platform.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const NO_CONNECTION = 'No connection to the control room right now.';

let reportReach: ((reached: boolean) => void) | null = null;
/** connectivity.ts registers itself here (kept as a callback so the service-worker bundle stays small). */
export function setReachReporter(fn: (reached: boolean) => void) {
  reportReach = fn;
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
    const res = await fetch(apiUrl(path), { ...rest, headers, signal: ctrl.signal, cache: 'no-store' });
    const text = await res.text();
    const body = parseJson(text);
    if (body === NOT_JSON) {
      // Not our server talking (proxy / tunnel error page, captive portal…): same as no connection.
      reportReach?.(false);
      throw new ApiError(0, res.status >= 500 ? `${NO_CONNECTION} (the link to the server answered with error ${res.status})` : NO_CONNECTION);
    }
    reportReach?.(true);
    if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `Server error ${res.status}`);
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    reportReach?.(false);
    throw new ApiError(0, (e as Error).name === 'AbortError' ? `${NO_CONNECTION} (no answer in time)` : NO_CONNECTION);
  } finally {
    clearTimeout(t);
  }
}

const NOT_JSON = Symbol('not json');

function parseJson(t: string): unknown {
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return NOT_JSON;
  }
}

/** Turns any error into text that is safe to show (never raw HTML). */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/<!doctype|<html|<head|<body/i.test(msg)) return NO_CONNECTION;
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}
