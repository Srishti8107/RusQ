/**
 * Vision E2E (§9): models cached during setup, then the REAL model runs in the
 * Web Worker with the network blocked; corrupt / huge images are handled; a
 * missing model falls back to manual tagging with a clear notice. Also measures
 * browser (WASM) latency on the fixture set → docs/vision-eval-browser.json.
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { FIXTURES, login, setup, startServer, waitForServiceWorker, type TestServer } from './helpers.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

const TMP = mkdtempSync(join(tmpdir(), 'rusq-vis-'));

test('real model works offline after setup; corrupt and huge images handled', async ({ page, context }) => {
  // Runs on both engines: WebKit uses the main-thread fallback (no OffscreenCanvas in its workers).
  await login(page, srv.url, 'ravi');
  await setup(page, ['keys', 'snapshot', 'location', 'vision']);
  await waitForServiceWorker(page);

  await context.setOffline(true);
  await page.goto(`${srv.url}/report`);
  await expect(page.getByTestId('reach')).toHaveText(/Offline/);
  await page.getByTestId('photo-input').setInputFiles(join(FIXTURES, 'flooded_street__0babde3d.jpg'));
  await expect(page.getByTestId('vision-state').first()).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
  await expect(page.getByTestId('vision-suggestion')).toContainText(/flooded street/);
  await expect(page.getByTestId('vision-state').first()).toContainText(/WASM|WEBGPU/);
  // suggestion pre-fills hazards but never touches urgency (default 3 stays)
  await expect(page.getByRole('checkbox', { name: /Flooded street/ })).toBeChecked();
  await expect(page.getByText('Urgency: 3 – Serious')).toBeVisible();
  await expect(page.getByTestId('resource-hints')).toContainText(/Boats/);
  await expect(page.getByTestId('res-boats').getByRole('checkbox')).not.toBeChecked(); // hints never auto-tick

  // corrupt image
  const corrupt = join(TMP, 'corrupt.jpg');
  writeFileSync(corrupt, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('this is not really a jpeg'.repeat(50))]));
  await page.getByTestId('photo-input').setInputFiles(corrupt);
  await expect(page.getByTestId('photo-error')).toContainText(/not a readable photo/);

  // huge image (8000×6000) → downscaled to ≤ 1280 px before analysis/storage
  const huge = join(TMP, 'huge.jpg');
  await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#3a6ea5' } }).jpeg({ quality: 60 }).toFile(huge);
  await page.getByTestId('photo-input').setInputFiles(huge);
  await expect(page.getByTestId('vision-state')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId('vision-state').nth(1)).toHaveAttribute('data-state', /done|failed/, { timeout: 120_000 });
});

test.describe('model missing (SW blocked so the 404 interception is airtight in every engine)', () => {
  test.use({ serviceWorkers: 'block' });
test('model missing → clear notice and manual tagging still works', async ({ page, context }) => {
  await login(page, srv.url, 'meena');
  await setup(page, ['keys', 'snapshot', 'location']);
  await context.route('**/models/**', (r) => r.fulfill({ status: 404, body: 'missing' }));
  await page.goto(`${srv.url}/report`);
  await page.getByTestId('photo-input').setInputFiles(join(FIXTURES, 'fire_or_smoke__2fb8d05d.jpg'));
  await expect(page.getByTestId('vision-fallback')).toContainText(/choose the hazards below yourself/, { timeout: 60_000 });
  await page.getByRole('checkbox', { name: /Fire or smoke/ }).check();
  await page.getByTestId('save-report').click();
  await expect(page.getByTestId('report-saved')).toBeVisible();
});

});

test('browser (WASM) latency over the fixture set, network blocked', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'measured on Chromium');
  test.setTimeout(900_000);
  await login(page, srv.url, 'ravi');
  await setup(page, ['keys', 'vision']);
  await waitForServiceWorker(page);
  await context.setOffline(true);
  await page.goto(`${srv.url}/report`);
  const labels = JSON.parse(readFileSync(join(FIXTURES, 'LABELS.json'), 'utf8')) as { file: string; label: string }[];
  const rows: { file: string; truth: string; top: string; ms: number; clipMs: number; detectMs: number; threads: number; warm: boolean; backend: string }[] = [];
  // Real UI path. One page (= one worker) per batch of 9 photos; the first photo of a
  // batch is "cold" (fresh worker), the rest are warm.
  for (let start = 0; start < labels.length; start += 9) {
    await page.goto(`${srv.url}/report`);
    const batch = labels.slice(start, start + 9);
    for (let i = 0; i < batch.length; i++) {
      const l = batch[i]!;
      await page.getByTestId('photo-input').setInputFiles(join(FIXTURES, l.file));
      const cap = page.getByTestId('vision-state').nth(i);
      await expect(cap).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
      const attr = async (n: string) => Number(await cap.getAttribute(n));
      rows.push({
        file: l.file,
        truth: l.label,
        top: (await cap.getAttribute('data-top')) ?? '',
        ms: await attr('data-latency-ms'),
        clipMs: await attr('data-clip-ms'),
        detectMs: await attr('data-detect-ms'),
        threads: await attr('data-threads'),
        warm: i > 0,
        backend: ((await cap.textContent()) ?? '').split(' ')[0]!,
      });
    }
  }
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const warmRows = rows.filter((r) => r.warm);
  const result = {
    runner: 'Chromium (Playwright, Pixel 7 profile, no CPU throttling), shipped Web Worker, network blocked',
    crossOriginIsolated: await page.evaluate(() => crossOriginIsolated),
    threads: [...new Set(rows.map((r) => r.threads))],
    fixtures: rows.length,
    backend: [...new Set(rows.map((r) => r.backend))],
    topHazardAccuracy: +(rows.filter((r) => r.top === r.truth).length / rows.length).toFixed(3),
    coldMedianMs: med(rows.filter((r) => !r.warm).map((r) => r.ms)),
    warmMedianMs: med(warmRows.map((r) => r.ms)),
    warmP90Ms: [...warmRows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(warmRows.length * 0.9)],
    warmMedianClipMs: med(warmRows.map((r) => r.clipMs)),
    warmMedianDetectMs: med(warmRows.map((r) => r.detectMs)),
    rows,
  };
  writeFileSync(join(FIXTURES, '../../../docs/vision-eval-browser.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, rows: undefined }));
  expect(rows.length).toBe(labels.length);
});
