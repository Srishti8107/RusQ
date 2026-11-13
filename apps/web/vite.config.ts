/**
 * Vite + PWA config.
 *  - Service worker: custom (src/sw.ts, injectManifest) so we control Background Sync,
 *    precaching and runtime caching of the vision runtime/models.
 *  - The ONNX Runtime WASM used by transformers.js is SELF-HOSTED under /ort/
 *    (default would be a CDN, which fails offline).
 *  - /api is proxied to the Fastify server in dev.
 */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

function selfHostOrt(): Plugin {
  const files = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];
  return {
    name: 'rusq-self-host-ort',
    buildStart() {
      const dist = dirname(require.resolve('@huggingface/transformers'));
      const out = resolve(__dirname, 'public/ort');
      mkdirSync(out, { recursive: true });
      for (const f of files) {
        const src = join(dist, f);
        if (existsSync(src) && !existsSync(join(out, f))) copyFileSync(src, join(out, f));
      }
    },
  };
}

export default defineConfig({
  plugins: [
    selfHostOrt(),
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        // Not precached: vision runtime/models (downloaded in setup), the map file (setup),
        // and the optional AI-helper worker (several MB; fetched only if a user turns it on).
        globIgnores: ['**/ort/**', '**/models/**', '**/fixtures/**', '**/map/**', '**/llm.worker-*.js'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      devOptions: { enabled: false },
      manifest: {
        id: '/',
        name: 'RusQ – Disaster Help',
        short_name: 'RusQ',
        description: 'Send SOS, report and coordinate rescue – works without internet.',
        start_url: '/?source=pwa',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#F4F7F6',
        theme_color: '#0B4A22',
        lang: 'en',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Android long-press shortcut → same SOS code path as the in-app button (§4).
        shortcuts: [
          {
            name: 'SOS – I need help',
            short_name: 'SOS',
            description: 'Send an emergency SOS',
            url: '/sos?source=shortcut',
            icons: [{ src: '/icons/sos-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
    }),
  ],
  resolve: { dedupe: ['react', 'react-dom'] },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  server: {
    host: true,
    port: 5173,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    proxy: { '/api': 'http://localhost:8787' },
  },
  preview: { port: 4173, proxy: { '/api': 'http://localhost:8787' } },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
