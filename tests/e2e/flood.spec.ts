/**
 * GATE 2 – the complete flood scenario end to end (§11), in emulation:
 *   register + cache online → connectivity fails (server unreachable) →
 *   offline SOS → offline rescue reports with REAL on-device vision and
 *   provisional allotments (two teams over-claim boats) → relay of the victim's
 *   SOS to the rescuers' phones over the EXPERIMENTAL LAN links (made AUTOMATICALLY while
 *   online, no QR) → reconnect and sync
 *   (rescuer acts as gateway; the victim's ack comes back over the link) →
 *   reconciliation conflict → admin approves/rejects in the UI → admin approves
 *   a recommendation → missing-person report verified by a named admin.
 * Chromium only (WebRTC between two Playwright WebKit contexts is not available on Windows).
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { apiGet, apiLogin, FIXTURES, login, setup, sosStatus as sosStatusOf, startServer, waitForServiceWorker, type TestServer } from './helpers.ts';
import { uuidv7, VERIFY_CHECKLIST } from '../../packages/shared/src/index.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

/** In-app navigation (keeps the page – and its live phone-to-phone links – alive; a page load would drop them). */
async function go(p: Page, label: string | RegExp) {
  await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click();
}

async function offlineReport(p: Page, photo: string | null, boats: string) {
  await go(p, 'New report');
  await expect(p.getByTestId('reach')).toHaveText(/Offline/, { timeout: 30_000 });
  await expect(p.getByTestId('report-location')).toBeVisible();
  if (photo) {
    await p.getByTestId('photo-input').setInputFiles(join(FIXTURES, photo));
    await expect(p.getByTestId('vision-state').first()).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
    await expect(p.getByTestId('vision-suggestion')).toContainText(/flooded street/);
    await expect(p.getByText('Urgency: 3 – Serious')).toBeVisible(); // vision never escalates urgency
  }
  for (let i = 0; i < 4; i++) await p.getByRole('button', { name: 'More people' }).click();
  await p.getByRole('button', { name: /Urgency 5/ }).click();
  await p.getByTestId('res-boats').getByRole('checkbox').check();
  await p.getByTestId('res-boats').getByRole('textbox').fill(boats);
  await expect(p.getByTestId('claim-boats')).toBeVisible();
  await p.getByTestId('save-report').click();
  await expect(p.getByTestId('report-saved')).toBeVisible();
  await expect(p.getByTestId('report-saved').getByTestId('delivery-status')).toHaveAttribute('data-status', 'queued');
}

/** Id of the newest outbox item of a kind, read from the phone's IndexedDB. */
function newestId(p: Page, kind: string) {
  return p.evaluate(async (k) => {
    const db = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('rusq');
      r.onsuccess = () => res(r.result);
    });
    const rows = await new Promise<{ id: string; kind: string; createdAt: string }[]>((res) => {
      const g = db.transaction('outbox').objectStore('outbox').getAll();
      g.onsuccess = () => res(g.result as { id: string; kind: string; createdAt: string }[]);
    });
    return rows.filter((r) => r.kind === k).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!.id;
  }, kind);
}

const openAutoLinks = (p: Page) => p.locator('[data-testid="lan-peer"][data-state="open"][data-how="auto"]');

test('flood scenario end to end', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'needs WebRTC between two contexts (Chromium)');
  test.setTimeout(900_000);
  const geo = (lat: number, lng: number) => ({ permissions: ['geolocation'], geolocation: { latitude: lat, longitude: lng } });
  const ctxV = await browser.newContext(geo(27.6945, 85.3215));
  const ctxR1 = await browser.newContext(geo(27.6941, 85.3212));
  const ctxR2 = await browser.newContext(geo(27.7012, 85.3234));
  const v = await ctxV.newPage();
  const r1 = await ctxR1.newPage();
  const r2 = await ctxR2.newPage();

  // ---------- 1. before the disaster (online): register (user ID only), cache everything
  const userId = `flood${Date.now() % 100000}`;
  await v.goto(`${srv.url}/register`);
  await v.getByLabel(/^User ID/).fill(userId);
  await v.getByLabel('Full name *').fill('Dipali Shrestha');
  await v.getByLabel('Age', { exact: true }).fill('34');
  await v.getByRole('button', { name: /Add a family member to call/ }).click();
  await v.getByLabel('Contact 1 name *').fill('Hemanta Shrestha');
  await v.getByLabel('Contact 1 phone *').fill('+977 00000 77777');
  await v.getByTestId('register-submit').click();
  await expect(v).toHaveURL(/\/setup/);
  await setup(v, ['shell', 'keys', 'map', 'shelters', 'location']);
  await waitForServiceWorker(v);

  await login(r1, srv.url, 'ravi');
  await setup(r1, ['shell', 'keys', 'snapshot', 'location', 'vision']);
  await waitForServiceWorker(r1);
  await login(r2, srv.url, 'kiran');
  await setup(r2, ['shell', 'keys', 'snapshot', 'location']);
  await waitForServiceWorker(r2);

  // ---------- 1b. the three phones are on the same network: they link up BY THEMSELVES (no QR, no code)
  for (const p of [v, r1, r2]) await p.goto(`${srv.url}/nearby`);
  for (const p of [v, r1, r2]) await expect(openAutoLinks(p)).toHaveCount(2, { timeout: 60_000 });

  // ---------- 2. disaster: the control room becomes unreachable (the phone links stay up)
  await srv.stop();
  await expect(v.getByTestId('reach')).toHaveText(/Offline/, { timeout: 30_000 });
  await go(v, 'SOS');
  await v.getByTestId('sos-button').click();
  await expect(v.getByTestId('sos-result')).toBeVisible({ timeout: 20_000 });
  await expect(sosStatusOf(v)).not.toHaveAttribute('data-status', 'received');
  const sosId = await newestId(v, 'sos');
  await go(v, 'Shelters near me'); // offline map still opens
  await expect(v.locator('[data-testid="map"][data-map-status="ready"]')).toBeVisible({ timeout: 30_000 });

  // ---------- 3–4. offline rescue reports: real vision + provisional allotments (both claim boats)
  await offlineReport(r1, 'flooded_street__0babde3d.jpg', '3');
  await offlineReport(r2, null, '3');

  // ---------- 5. relay: the victim's SOS hops to the rescuers' phones over the LAN links (server still down)
  await go(r2, 'Nearby phones');
  await expect(r2.locator(`[data-testid="lan-held-item"][data-id="${sosId}"]`)).toBeVisible({ timeout: 30_000 });
  await go(v, 'SOS');
  await expect(sosStatusOf(v)).toHaveAttribute('data-status', 'sent'); // handed to a phone ≠ received
  await expect(v.getByTestId('sos-result')).toContainText('passed to a nearby phone');

  // ---------- 6. connectivity returns for the rescuers only; the victim still has no path of her own
  await ctxV.route('**/api/**', (r) => r.abort());
  await srv.restart();
  const admin = await apiLogin(srv.url, 'admin');
  await expect
    .poll(async () => (await apiGet<{ id: string; via: string }[]>(srv.url, '/admin/sos', admin)).map((s) => `${s.id}:${s.via}`), { timeout: 60_000 })
    .toContain(`${sosId}:relay`);
  await expect(sosStatusOf(v)).toHaveAttribute('data-status', 'received', { timeout: 60_000 }); // signed ack came back over the link
  await expect(v.getByTestId('sos-result')).toContainText(/reached the control room/);
  for (const p of [r1, r2]) {
    await go(p, 'Home');
    await expect(p.getByTestId('my-reports').getByTestId('delivery-status').first()).toHaveAttribute('data-status', 'received', { timeout: 60_000 });
  }

  // ---------- 7. reconciliation: 3 + 3 boats claimed > live stock → conflict, nothing overwritten
  const rec = await apiGet<{ conflicts: { resource: string; status: string }[]; allotments: { status: string }[] }>(srv.url, '/admin/reconciliation', admin);
  expect(rec.allotments.filter((a) => a.status === 'pending')).toHaveLength(2);
  expect(rec.conflicts.filter((c) => c.status === 'open').map((c) => c.resource)).toContain('boats');
  const reports = await apiGet<{ aiSuggestion: { backend: string } | null }[]>(srv.url, '/admin/reports', admin);
  expect(reports.some((r) => r.aiSuggestion && r.aiSuggestion.backend !== 'mock')).toBe(true);

  // ---------- 8. administrator decides in the UI
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  await login(a, srv.url, 'admin');
  await a.goto(`${srv.url}/admin/reconcile`);
  await expect(a.getByTestId('conflict').first()).toContainText(/Boats/i);
  await a.getByTestId('allotment').first().getByTestId('approve').click();
  await expect(a.getByTestId('allotment')).toHaveCount(1, { timeout: 20_000 });
  await a.getByTestId('allotment').first().getByTestId('reject').click();
  await expect(a.getByTestId('allotment')).toHaveCount(0, { timeout: 20_000 });
  await expect(a.getByTestId('conflict')).toHaveCount(0);

  await a.goto(`${srv.url}/admin/sos`);
  await expect(a.getByTestId('sos-card').filter({ hasText: 'Dipali Shrestha' })).toContainText('+977 00000 77777');
  await expect(a.getByTestId('sos-card').filter({ hasText: 'Dipali Shrestha' })).toContainText('phone-to-phone relay');
  await a.goto(`${srv.url}/admin/decisions`);
  await a.getByTestId('rec-card').first().getByTestId('rec-approve').click();
  await expect(a.getByTestId('rec-decided').first()).toContainText('Approved');

  // ---------- 9. recovery: missing person → verified by a named admin → announced
  await ctxV.unroute('**/api/**');
  const vt = await apiLogin(srv.url, 'asha'); // a second family, via the API
  const me = await apiGet<{ user: { id: string } }>(srv.url, '/me', vt);
  const mid = uuidv7();
  const post = (path: string, token: string, body: unknown) =>
    fetch(`${srv.url}/api${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('/sync', vt, {
    items: [{ kind: 'missing', data: { id: mid, reporterId: me.user.id, person: { name: 'Bikash Tamang', age: 70, gender: 'male', description: 'elderly man with a walking stick' }, lastSeen: { place: 'Tundikhel' }, contactPhone: '+977 00000 88888', relation: 'son', createdAt: new Date().toISOString() } }],
  });
  expect((await post(`/admin/missing/${mid}/action`, admin, { action: 'announce' })).status).toBe(409); // cannot skip
  await a.goto(`${srv.url}/admin/missing`);
  const card = a.getByTestId('missing-case').filter({ hasText: 'Bikash Tamang' });
  await card.getByTestId('start-review').click();
  for (const c of VERIFY_CHECKLIST) await card.getByLabel(c.label).check();
  await card.getByLabel(/Verification note/).fill('Confirmed with the camp registrar by phone.');
  await card.getByTestId('verify').click();
  await expect(card).toHaveAttribute('data-state', 'verified');
  await card.getByTestId('announce').click();
  await expect(card).toHaveAttribute('data-state', 'announced');

  // ---------- 10. every decision is in the audit log
  const audit = (await apiGet<{ action: string }[]>(srv.url, '/admin/audit', admin)).map((x) => x.action);
  for (const act of ['auth.registered', 'sos.received', 'report.received', 'conflict.created', 'allotment.approved', 'allotment.rejected', 'conflict.resolved', 'recommendation.approved', 'missing.verify', 'missing.announce'])
    expect(audit, act).toContain(act);

  for (const c of [ctxV, ctxR1, ctxR2, ctxA]) await c.close();
});
