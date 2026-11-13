/**
 * Real offline detection (§5). "Online" means: THIS phone can reach the RusQ server right now –
 * not just "a network interface exists" (navigator.onLine).
 *
 * Why the badge used to be wrong at times (decisions.md 12.1), and what this file does about it:
 *  1. ONE slow answer flipped it to Offline: a 3 s timeout over a phone network / HTTPS tunnel,
 *     or a probe queued behind photo uploads. → 6 s timeout and TWO failed checks in a row
 *     before showing Offline (one success is enough for Online).
 *  2. The browser's "offline" event was trusted blindly (Windows virtual adapters and Wi-Fi
 *     hand-overs fire it while the internet still works). → it only triggers an immediate check.
 *  3. Recovery was slow: one check every 20 s, and none while the tab was hidden.
 *     → every 4 s while offline, every 15 s while online, also when hidden (slower).
 *  4. Other requests' results were ignored: an API call could succeed while the badge said
 *     Offline (or fail while it said Online). → api.ts reports every result here.
 *  5. Error pages from a proxy / tunnel (HTTP 502/530 HTML pages) counted as "reached".
 *     → only a JSON {ok:true} from /api/health counts.
 */
import { apiUrl } from './platform.ts';
import { setReachReporter } from './api.ts';

export type Reach = 'online' | 'offline' | 'checking';

type Listener = (r: Reach) => void;
let state: Reach = 'checking';
const listeners = new Set<Listener>();
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<Reach> | null = null;
let failures = 0;

export const PROBE_TIMEOUT_MS = 6000;
export const ONLINE_INTERVAL_MS = 15_000;
export const OFFLINE_INTERVAL_MS = 4000;
export const FAILURES_BEFORE_OFFLINE = 2;

export function currentReach(): Reach {
  return state;
}

function set(r: Reach) {
  if (r === state) return;
  state = r;
  for (const l of listeners) l(r);
  if (started) schedule(); // the check interval depends on the state
}

function browserSaysOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function recordSuccess() {
  failures = 0;
  set('online');
}

function recordFailure() {
  failures++;
  // Show Offline at once when we never were online, or the browser has no network at all;
  // otherwise only after a second failed check (one slow answer is not "offline").
  if (state !== 'online' || failures >= FAILURES_BEFORE_OFFLINE || browserSaysOffline()) set('offline');
  else setTimeout(() => void probe(), 1500); // confirm quickly
}

/** Probe the server. Counts as reached only on HTTP 200 with JSON {ok:true} within `timeoutMs`. */
export async function probe(timeoutMs = PROBE_TIMEOUT_MS): Promise<Reach> {
  if (inflight) return inflight;
  inflight = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(apiUrl(`/health?t=${Date.now()}`), { cache: 'no-store', signal: ctrl.signal });
      const body = res.ok ? await res.text() : '';
      let ok = false;
      try {
        ok = (JSON.parse(body) as { ok?: boolean }).ok === true;
      } catch {
        ok = false; // an HTML error page from a proxy / tunnel is NOT the server
      }
      if (ok) recordSuccess();
      else recordFailure();
    } catch {
      recordFailure();
    } finally {
      clearTimeout(t);
      inflight = null;
    }
    return state;
  })();
  return inflight;
}

/** Called by api.ts after every request: a real server answer proves we are online; a network failure triggers a check. */
export function reportApiResult(reachedServer: boolean) {
  if (reachedServer) recordSuccess();
  else void probe();
}

export function onReachChange(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function schedule() {
  if (timer) clearTimeout(timer);
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const base = state === 'online' ? ONLINE_INTERVAL_MS : OFFLINE_INTERVAL_MS;
  timer = setTimeout(
    () => {
      void probe().finally(schedule);
    },
    hidden ? base * 2 : base,
  );
}

/** Start background checking: on browser online/offline events, when the app comes back to the screen, and on a timer. */
export function startConnectivityMonitor() {
  if (started) return;
  started = true;
  window.addEventListener('online', () => void probe());
  window.addEventListener('offline', () => void probe()); // check – don't trust the event blindly
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void probe();
  });
  void probe();
  schedule();
}

// Every API result feeds the badge (see point 4 above).
setReachReporter(reportApiResult);
