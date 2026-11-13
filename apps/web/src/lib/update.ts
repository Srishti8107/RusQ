/**
 * Safe app updates (§5): the service worker is registered with registerType
 * "prompt". We only CHECK for a new version when the server is reachable and
 * the page is idle; a downloaded update waits until the user taps "Update now".
 * Workbox precaching is atomic, so an interrupted download never replaces the
 * working offline copy.
 */
import { registerSW } from 'virtual:pwa-register';
import { currentReach } from './connectivity.ts';

type Listener = (ready: boolean) => void;
let updateReady = false;
let doUpdate: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<Listener>();

export function onUpdateReady(l: Listener) {
  listeners.add(l);
  l(updateReady);
  return () => {
    listeners.delete(l);
  };
}

export function applyUpdate() {
  void doUpdate?.(true);
}

export function startUpdateWatcher() {
  if (!('serviceWorker' in navigator)) return;
  doUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateReady = true;
      listeners.forEach((l) => l(true));
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => {
        if (currentReach() !== 'online' || document.visibilityState !== 'visible') return;
        const idle = (cb: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 10_000 }) : setTimeout(cb, 2000));
        idle(() => void reg.update().catch(() => {}));
      };
      setInterval(check, 30 * 60 * 1000);
    },
  });
}
