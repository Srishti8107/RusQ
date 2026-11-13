/// <reference lib="webworker" />
/**
 * Service worker (§5):
 *  - precaches the full app shell (Workbox manifest injected at build). Workbox
 *    installs a new version atomically: if any asset fails to download, the new
 *    SW never activates and the old, complete cache keeps serving → a half-updated
 *    cache can never break the offline app.
 *  - registerType "prompt": a new version waits until the user taps "Update"
 *    (and the page only checks for updates when online and idle).
 *  - runtime cache-first for /models/ and /ort/ (vision models + ONNX runtime) and for the
 *    optional AI-helper worker chunk. The offline map lives in its own cache ("rusq-map"),
 *    written by the setup screen.
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
    denylist: [/^\/api\//, /^\/models\//, /^\/ort\//, /^\/fixtures\//, /^\/map\//],
  }),
);

registerRoute(({ url }) => url.origin === self.location.origin && (url.pathname.startsWith('/models/') || url.pathname.startsWith('/ort/')), new CacheFirst({ cacheName: 'rusq-models' }));

// Optional AI-helper worker chunk (not precached): keep it once it was downloaded, so the
// helper keeps working offline. The model weights themselves are cached by WebLLM.
registerRoute(({ url }) => url.origin === self.location.origin && /^\/assets\/llm\.worker-[\w-]+\.js$/.test(url.pathname), new CacheFirst({ cacheName: 'rusq-llm' }));

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

// Tapping the "Your SOS reached the control room" notification opens RusQ (decisions.md 12.12).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = all[0];
      if (open) return open.focus();
      await self.clients.openWindow('/');
    })(),
  );
});
