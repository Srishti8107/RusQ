/**
 * PWA / platform checks (§5, §9):
 *  - allocation output byte-identical: browser JS engine (V8 on pixel, JavaScriptCore
 *    on iphone) vs the server, for seeded random inputs
 *  - axe accessibility scan on every Phase 1 screen
 *  - Chrome's own installability verdict (CDP Page.getInstallabilityErrors) + manifest
 *  - cold start offline after the browser was fully closed (persistent profile)
 *  - Mesh Lab (SIMULATED) delivers a message end to end in the UI
 */
import { chromium, expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiLogin, login, setup, startServer, waitForServiceWorker, type TestServer } from './helpers.ts';
import { mulberry32, RESOURCE_KEYS } from '../../packages/shared/src/index.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

function randomInput(seed: number) {
  const rng = mulberry32(seed);
  const int = (n: number) => Math.floor(rng() * n);
  const sites = Array.from({ length: 1 + int(9) }, (_, i) => ({
    id: `s-${seed}-${i}`,
    kind: rng() < 0.5 ? 'shelter' : 'incident',
    density: rng() < 0.1 ? 0 : int(rng() < 0.2 ? 10_000_000 : 3000),
    urgency: 1 + int(5),
    needs: Object.fromEntries(RESOURCE_KEYS.filter(() => rng() < 0.5).map((k) => [k, int(600)])),
  }));
  const stock = Object.fromEntries(RESOURCE_KEYS.filter(() => rng() < 0.8).map((k) => [k, int(900)]));
  return { snapshotVersion: 1 + int(9), stock, sites, provisional: rng() < 0.5 };
}

test('allocation engine output is byte-identical in this browser and on the server (200 random inputs)', async ({ page }) => {
  const token = await apiLogin(srv.url, 'ravi');
  await page.goto(`${srv.url}/login`);
  await page.waitForFunction(() => !!(window as unknown as { __rusq?: unknown }).__rusq);
  let compared = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const input = randomInput(seed);
    const server = await (await fetch(`${srv.url}/api/allocate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) })).text();
    const client = await page.evaluate((inp) => JSON.stringify((window as unknown as { __rusq: { allocate: (i: unknown) => unknown } }).__rusq.allocate(inp)), input);
    expect(client, `seed ${seed}`).toBe(server);
    compared++;
  }
  expect(compared).toBe(200);
});

test('accessibility: no serious/critical axe violations on Phase 1 screens', async ({ page }) => {
  const screens: [string, string][] = [['login', '/login']];
  await page.goto(`${srv.url}/login`);
  const results: Record<string, string[]> = {};
  const scan = async (name: string) => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    results[name] = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.length} node(s) – ${v.help}`);
  };
  await scan('login');
  await login(page, srv.url, 'ravi');
  for (const [name, path] of [
    ['setup', '/setup'],
    ['home', '/'],
    ['sos', '/sos'],
    ['report', '/report'],
    ['outbox', '/outbox'],
    ['nearby', '/nearby'],
    ['mesh-lab', '/mesh-lab'],
    ['settings', '/settings'],
  ]) {
    screens.push([name, path]);
    await page.goto(`${srv.url}${path}`);
    await page.waitForTimeout(800);
    await scan(name);
  }
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, srv.url, 'admin');
  await page.goto(`${srv.url}/admin/reconcile`);
  await page.waitForTimeout(800);
  await scan('admin-reconcile');
  console.log('axe', JSON.stringify(results));
  for (const [name, v] of Object.entries(results)) expect(v, name).toEqual([]);
});

test('installable: Chrome reports no installability errors; manifest has SOS shortcut', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP installability check is Chromium-only');
  await page.goto(`${srv.url}/login`);
  await waitForServiceWorker(page);
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: { errorId: string }[] };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);
  const manifest = await (await page.request.get(`${srv.url}/manifest.webmanifest`)).json();
  expect(manifest.shortcuts[0].url).toBe('/sos?source=shortcut');
  expect(manifest.display).toBe('standalone');
});

test('cold start offline after the browser was closed (persistent profile)', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'persistent profile test runs on Chromium');
  const dir = mkdtempSync(join(tmpdir(), 'rusq-profile-'));
  let ctx = await chromium.launchPersistentContext(dir, { permissions: ['geolocation'], geolocation: { latitude: 26.16, longitude: 91.78 } });
  let page = ctx.pages()[0] ?? (await ctx.newPage());
  await login(page, srv.url, 'asha');
  await setup(page, ['shell', 'keys', 'shelters']);
  await waitForServiceWorker(page);
  await ctx.close(); // browser fully closed

  ctx = await chromium.launchPersistentContext(dir, { offline: true });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${srv.url}/`);
  await expect(page.getByTestId('reach')).toHaveText(/Offline/);
  await expect(page.getByRole('heading', { name: /Hello, Asha/ })).toBeVisible();
  await page.goto(`${srv.url}/sos`);
  await page.getByTestId('sos-button').click();
  await expect(page.getByTestId('sos-result')).toContainText('Saved on this phone only', { timeout: 20_000 });
  await ctx.close();
});

test('Mesh Lab (SIMULATED) delivers an SOS end to end', async ({ page }) => {
  await login(page, srv.url, 'ravi');
  await page.goto(`${srv.url}/mesh-lab`);
  await expect(page.getByText('SIMULATED').first()).toBeVisible();
  await expect(page.getByTestId('meshlab-canvas')).toBeVisible();
  // Max radio range so the seeded topology is connected; pick a non-gateway phone.
  await page.getByLabel(/Radio range/).fill('60');
  await page.getByTestId('meshlab-pick').selectOption('n07');
  await page.getByTestId('meshlab-sos').click();
  for (let i = 0; i < 80 && (await page.getByTestId('meshlab-delivered').textContent()) === '0'; i++) await page.getByTestId('meshlab-step').click();
  await expect(page.getByTestId('meshlab-delivered')).not.toHaveText('0');
});
