/**
 * Real offline detection (§5): `navigator.onLine` only tells us a network
 * interface exists. We show "online" only after a short-timeout request to
 * /api/health succeeds.
 */
export type Reach = 'online' | 'offline' | 'checking';

type Listener = (r: Reach) => void;
let state: Reach = 'checking';
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<Reach> | null = null;

export function currentReach(): Reach {
  return state;
}

function set(r: Reach) {
  if (r === state) return;
  state = r;
  for (const l of listeners) l(r);
}

/** Probe the server. Resolves 'online' only on an HTTP 200 with {ok:true} within `timeoutMs`. */
export async function probe(timeoutMs = 3000): Promise<Reach> {
  if (inflight) return inflight;
  inflight = (async () => {
    // navigator.onLine is NOT trusted in either direction: some browsers (seen in WebKit)
    // keep reporting false after the network returns. The health probe decides.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`/api/health?t=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
      const ok = res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
      set(ok ? 'online' : 'offline');
    } catch {
      set('offline');
    } finally {
      clearTimeout(t);
      inflight = null;
    }
    return state;
  })();
  return inflight;
}

export function onReachChange(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Start background probing: on online/offline events, on focus, and every `intervalMs`. */
export function startConnectivityMonitor(intervalMs = 20_000) {
  if (timer) return;
  window.addEventListener('online', () => void probe());
  window.addEventListener('offline', () => set('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void probe();
  });
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') void probe();
  }, intervalMs);
  void probe();
}
