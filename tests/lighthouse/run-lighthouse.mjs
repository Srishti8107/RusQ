/**
 * Lighthouse mobile audit (§5, §9) against a freshly started server.
 * Lighthouse 12 REMOVED the "PWA" category – installability is checked with
 * Chrome's own verdict in tests/e2e/pwa.spec.ts and offline behaviour by the
 * offline E2E tests. Here: performance, accessibility, best practices, SEO with
 * Lighthouse's default mobile emulation (Moto G Power class, 4× CPU slowdown,
 * slow 4G).  Writes docs/lighthouse.json.
 *
 *   node tests/lighthouse/run-lighthouse.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import lighthouse from 'lighthouse';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = 8899;
const srv = spawn(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'apps/server/src/index.ts')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', RUSQ_DB: join(mkdtempSync(join(tmpdir(), 'rusq-lh-')), 'db.sqlite'), RUSQ_STATIC: join(ROOT, 'apps/web/dist'), NODE_ENV: 'test' },
  stdio: 'ignore',
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const CDP_PORT = 9333;
const browser = await chromium.launch({ args: [`--remote-debugging-port=${CDP_PORT}`] });
const chrome = { port: CDP_PORT, kill: () => browser.close() };
const out = {};
try {
  for (const path of ['/login']) {
    const r = await lighthouse(`http://127.0.0.1:${PORT}${path}`, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'], formFactor: 'mobile' });
    const lhr = r.lhr;
    out[path] = {
      lighthouseVersion: lhr.lighthouseVersion,
      scores: Object.fromEntries(Object.entries(lhr.categories).map(([k, v]) => [k, Math.round(v.score * 100)])),
      metrics: {
        FCP_ms: Math.round(lhr.audits['first-contentful-paint'].numericValue),
        LCP_ms: Math.round(lhr.audits['largest-contentful-paint'].numericValue),
        TBT_ms: Math.round(lhr.audits['total-blocking-time'].numericValue),
        CLS: +lhr.audits['cumulative-layout-shift'].numericValue.toFixed(3),
      },
      throttling: lhr.configSettings.throttling,
      failedAudits: Object.values(lhr.audits)
        .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'notApplicable')
        .map((a) => `${a.id} (${a.score})`)
        .slice(0, 15),
    };
  }
} finally {
  await chrome.kill();
  srv.kill();
}
writeFileSync(join(ROOT, 'docs/lighthouse.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
