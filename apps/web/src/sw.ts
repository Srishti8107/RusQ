/// <reference lib="webworker" />
/**
 * Service worker (§5):
 *  - precaches the full app shell (Workbox manifest injected at build). Workbox
 *    installs a new version atomically: if any asset fails to download, the new
 *    SW never activates and the old, complete cache keeps serving → a half-updated
 *    cache can never break the offline app.
 *  - registerType "prompt": a new version waits until the user taps "Update"
 *    (and the page only checks for updates when online and idle).
 *  - runtime cache-first for /models/ and /ort/ (vision models + ONNX runtime).
 *  - Background Sync ("rusq-sync") runs the same sync engine as the page.
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { syncNow } from './lib/sync.ts';

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/models\//, /^\/ort\//, /^\/fixtures\//],
  }),
);

registerRoute(({ url }) => url.origin === self.location.origin && (url.pathname.startsWith('/models/') || url.pathname.startsWith('/ort/')), new CacheFirst({ cacheName: 'rusq-models' }));

self.addEventListener('message', (e) => {
  if ((e.data as { type?: string })?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

interface SyncEvent extends ExtendableEvent {
  tag: string;
}
self.addEventListener('sync' as never, (e: SyncEvent) => {
  if (e.tag === 'rusq-sync') {
    e.waitUntil(
      syncNow('background-sync').then((r) => {
        if (r.skipped === 'offline') throw new Error('still offline – let the browser retry');
      }),
    );
  }
});
