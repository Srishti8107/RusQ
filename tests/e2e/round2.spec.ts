/**
 * Owner's second change list (decisions.md section 13), in emulation:
 *  13.1 a family attaches a photo to a missing-person report; the control room sees it
 *  13.3 MULTI-HOP without internet: phone A → phone B → phone C → server, with the alerts
 *       "Connected to <user> and transferring …" / "Receiving from <user> …", hop numbers in the
 *       transfer log, the server recording 2 hops + the uploading user, and the confirmation
 *       travelling back C → B → A
 *  13.4 the control room gets a pop-up for every new SOS and field report
 * Two/three contexts on one PC ≠ phones on a hotspot (PHONE_TEST.md).
 */
import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiLogin, FIXTURES, login, setup, startServer, waitForServiceWorker, type TestServer } from './helpers.ts';
import { join } from 'node:path';
import { uuidv7 } from '../../packages/shared/src/index.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

const go = (p: Page, label: string) => p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click();
const toastWith = (p: Page, text: RegExp) => p.getByTestId('toast').filter({ hasText: text }).first();
const openAuto = (p: Page) => p.locator('[data-testid="lan-peer"][data-state="open"][data-how="auto"]');

test('13.3 multi-hop with no internet: A → B → C → server, alerts on every phone, 2 hops recorded, confirmation back to A', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'needs WebRTC between contexts (Chromium)');
  test.setTimeout(400_000);
  const geo = { permissions: ['geolocation'], geolocation: { latitude: 27.6941, longitude: 85.3212 } };
  const [ca, cb, cc] = [await browser.newContext(geo), await browser.newContext(geo), await browser.newContext(geo)];
  const [a, b, c] = [await ca.newPage(), await cb.newPage(), await cc.newPage()];
  for (const [p, u] of [
    [a, 'ravi'],
    [b, 'meena'],
    [c, 'kiran'],
  ] as const) {
    await login(p, srv.url, u);
    await setup(p, u === 'ravi' ? ['keys', 'snapshot', 'location'] : ['keys']);
    await waitForServiceWorker(p);
  }
  // while the server is reachable, the three phones link up by themselves
  for (const p of [a, b, c]) await p.goto(`${srv.url}/nearby`);
  for (const p of [a, b, c]) await expect(openAuto(p)).toHaveCount(2, { timeout: 60_000 });
  await expect(a.getByTestId('lan-peer-user').filter({ hasText: 'meena' })).toBeVisible(); // user IDs, not device ids

  // ---- disaster: no server. Cut the direct A–C link so the only path is A → B → C.
  await srv.stop();
  await expect(a.getByTestId('reach')).toHaveText(/Offline/, { timeout: 30_000 });
  await a.getByTestId('lan-peer').filter({ hasText: 'kiran' }).getByRole('button', { name: 'Disconnect' }).click();
  await expect(openAuto(a)).toHaveCount(1);
  await expect(openAuto(c)).toHaveCount(1, { timeout: 20_000 });

  // ---- A (offline) saves a report, using in-app navigation so the live links stay up
  await go(a, 'New report');
  await expect(a.getByTestId('report-location')).toBeVisible();
  await a.getByRole('button', { name: 'More people' }).click();
  await a.getByTestId('save-report').click();
  await expect(a.getByTestId('report-saved')).toBeVisible();
  const reportId = await a.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('rusq');
      r.onsuccess = () => res(r.result);
    });
    const rows = await new Promise<{ id: string; kind: string }[]>((res) => {
      const g = db.transaction('outbox').objectStore('outbox').getAll();
      g.onsuccess = () => res(g.result as { id: string; kind: string }[]);
    });
    return rows.find((r) => r.kind === 'report')!.id;
  });

  // alerts on every phone, with user IDs
  await expect(toastWith(a, /Connected to meena and transferring your field report/)).toBeVisible({ timeout: 30_000 });
  await expect(toastWith(b, /Receiving from ravi: .*field report.*team-alpha/)).toBeVisible({ timeout: 30_000 });
  await expect(toastWith(b, /Connected to kiran – passing on .*field report/)).toBeVisible({ timeout: 30_000 });
  await expect(toastWith(c, /Receiving from meena: .*field report.*team-alpha/)).toBeVisible({ timeout: 30_000 });
  // the transfer log proves the hop numbers: B got it as hop 1, C as hop 2
  await expect(b.locator('[data-testid="transfer-entry"][data-dir="in"][data-hops="1"]').first()).toContainText('ravi');
  await expect(c.locator('[data-testid="transfer-entry"][data-dir="in"][data-hops="2"]').first()).toContainText('meena');

  // ---- only C gets internet back (A and B stay cut off) → C is the gateway
  await ca.route('**/api/**', (r) => r.abort());
  await cb.route('**/api/**', (r) => r.abort());
  await srv.restart();
  const admin = await apiLogin(srv.url, 'admin');
  await expect
    .poll(async () => (await apiGet<{ id: string; relayHops: number | null; relayGateway: string | null }[]>(srv.url, '/admin/reports', admin)).find((r) => r.id === reportId), { timeout: 60_000 })
    .toMatchObject({ relayHops: 2, relayGateway: 'kiran' });

  // ---- the signed confirmation travels back C → B → A
  await expect(toastWith(a, /control room confirmed your field report/)).toBeVisible({ timeout: 60_000 });
  await expect(toastWith(a, /came back through meena/)).toBeVisible();
  for (const x of [ca, cb, cc]) await x.close();
});

test('13.1 a family attaches a photo of the missing person; the control room sees it', async ({ browser }) => {
  const fam = await browser.newContext();
  const f = await fam.newPage();
  await login(f, srv.url, 'asha');
  await f.goto(`${srv.url}/missing`);
  await f.getByLabel('Their full name *').fill('Puja Shrestha');
  await f.getByLabel('Where were they last seen? *').fill('Lainchaur');
  await f.getByLabel('Phone number to reach you *').fill('+977 00000 44444');
  await f.getByTestId('missing-photo-input').setInputFiles(join(FIXTURES, 'flooded_street__0babde3d.jpg'));
  await expect(f.getByAltText('Photo 1 of the missing person')).toBeVisible({ timeout: 20_000 });
  await f.getByTestId('missing-submit').click();
  const row = f.getByTestId('missing-row').filter({ hasText: 'Puja Shrestha' });
  await expect(row.getByTestId('missing-own-photos')).toContainText('1 of 1 photo(s) received', { timeout: 40_000 });

  const adm = await browser.newContext();
  const a = await adm.newPage();
  await login(a, srv.url, 'admin');
  await a.goto(`${srv.url}/admin/missing`);
  const card = a.getByTestId('missing-case').filter({ hasText: 'Puja Shrestha' });
  const img = card.getByTestId('missing-photos').locator('img');
  await expect(img).toBeVisible({ timeout: 20_000 });
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(50); // real image bytes, loaded with the admin token
  await fam.close();
  await adm.close();
});

test('13.4 the control room gets a pop-up for a new SOS and a new field report, on any admin screen', async ({ page }) => {
  await login(page, srv.url, 'admin');
  await page.goto(`${srv.url}/admin/people`); // any admin screen
  await page.waitForTimeout(2500); // the feed has started its clock
  const asha = await apiLogin(srv.url, 'asha');
  const me = await apiGet<{ user: { id: string } }>(srv.url, '/me', asha);
  const post = (token: string, body: unknown) =>
    fetch(`${srv.url}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post(asha, { items: [{ kind: 'sos', data: { id: uuidv7(), userId: me.user.id, lat: 27.6945, lng: 85.3215, accuracy: 20, locationSource: 'live', createdAt: new Date().toISOString(), source: 'app', profile: { name: 'Asha Gurung', contacts: [] } } }] });
  const sos = toastWith(page, /New SOS from Asha Gurung/);
  await expect(sos).toBeVisible({ timeout: 20_000 });
  await expect(sos).toHaveAttribute('data-kind', 'sos');
  const ravi = await apiLogin(srv.url, 'ravi');
  await post(ravi, {
    items: [
      {
        kind: 'report',
        data: { id: uuidv7(), teamId: 'team-alpha', lat: 27.69, lng: 85.32, locationSource: 'live', victimCount: 7, urgency: 4, notes: '', photos: [], requested: {}, aiSuggestion: null, humanFinal: { hazards: ['flooded street'], victimCount: 7, urgency: 4, requested: {} }, createdAt: new Date().toISOString() },
      },
    ],
  });
  await expect(toastWith(page, /New field report from team-alpha/)).toContainText('7 people');
  await sos.screenshot({ path: test.info().outputPath('admin-sos-popup.png') });
  await page.screenshot({ path: 'test-results/admin-popups.png' });
  await page.waitForTimeout(12_000);
  await expect(sos).toBeVisible(); // an SOS alert stays until it is closed
  await sos.getByRole('link', { name: 'Open SOS monitor' }).click();
  await expect(page).toHaveURL(/\/admin\/sos$/);
  await expect(page.getByTestId('toast').filter({ hasText: /New SOS from Asha/ })).toHaveCount(0);
});
