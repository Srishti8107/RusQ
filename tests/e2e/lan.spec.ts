/**
 * EXPERIMENTAL LAN peer link (§9, decisions.md 12.9): two browser contexts on the "same
 * network" connect BY THEMSELVES (no QR, no code) while the server is reachable, keep the real
 * WebRTC data channel when the SERVER STOPS, exchange a report over it, and when the server
 * comes back phone B acts as gateway and the server ack travels back over the link.
 * The copy-paste code stays as a fallback and is tested separately.
 * Two contexts on one machine ≠ two phones on a hotspot (see PHONE_TEST.md).
 */
import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiLogin, login, setup, startServer, waitForServiceWorker, type TestServer } from './helpers.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});


const openLink = (p: Page, how: 'auto' | 'code') => p.locator(`[data-testid="lan-peer"][data-state="open"][data-how="${how}"]`).first();

test('two phones connect automatically, exchange a report while the server is down; the ack returns over the link', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium' && !process.env.RUSQ_TRY_WEBKIT, 'WebRTC between two WebKit contexts: best-effort, run with RUSQ_TRY_WEBKIT=1');
  const ctxA = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 27.69, longitude: 85.32 } });
  const ctxB = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 27.70, longitude: 85.31 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a, srv.url, 'ravi');
  await setup(a, ['keys', 'snapshot', 'location']);
  await waitForServiceWorker(a);
  await login(b, srv.url, 'meena');
  await setup(b, ['keys', 'snapshot']);
  await waitForServiceWorker(b);

  // ---- no QR, no code: both phones just open the app on the same network and link up
  await a.goto(`${srv.url}/nearby`);
  await b.goto(`${srv.url}/nearby`);
  await expect(openLink(a, 'auto')).toBeVisible({ timeout: 40_000 });
  await expect(openLink(b, 'auto')).toBeVisible({ timeout: 20_000 });

  // ---- server goes down; the link stays up
  await srv.stop();
  await expect(a.getByTestId('reach')).toHaveText(/Offline/, { timeout: 30_000 });
  await expect(openLink(a, 'auto')).toBeVisible();
  // make the report in the SAME tab via in-app navigation (a page load would drop the live link)
  const nav = a.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'New report' }).click();
  await expect(a.getByTestId('report-location')).toBeVisible();
  await a.getByRole('button', { name: 'More people' }).click();
  await a.getByTestId('save-report').click();
  await expect(a.getByTestId('report-saved')).toBeVisible();
  await nav.getByRole('link', { name: 'Nearby phones' }).click();
  const status = await ctxA.newPage(); // second tab only to read the status shown on Home
  await status.goto(`${srv.url}/`);
  const reportId = await status.evaluate(async () => {
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

  // ---- B now carries A's report (store-and-forward); A's status is 'sent', never 'received'
  await expect(b.locator(`[data-testid="lan-held-item"][data-id="${reportId}"]`)).toBeVisible({ timeout: 30_000 });
  await status.goto(`${srv.url}/`);
  const reportStatus = () => status.getByTestId('my-reports').getByTestId('delivery-status').first();
  await expect(reportStatus()).toHaveAttribute('data-status', 'sent', { timeout: 20_000 });

  // ---- server back. A's own direct path stays blocked, so the ack can ONLY come back via B.
  await ctxA.route('**/api/**', (r) => r.abort());
  await srv.restart();
  await expect(b.getByTestId('reach')).toHaveText(/Online/, { timeout: 40_000 });
  const admin = await apiLogin(srv.url, 'admin');
  await expect
    .poll(async () => (await apiGet<{ id: string; via: string }[]>(srv.url, '/admin/reports', admin)).map((r) => `${r.id}:${r.via}`), { timeout: 40_000 })
    .toContain(`${reportId}:relay`);
  // the signed server ack travels B → A over the LAN link → A shows received
  await expect(reportStatus()).toHaveAttribute('data-status', 'received', { timeout: 40_000 });
  await ctxA.close();
  await ctxB.close();
});

test('fallback: phones that cannot reach the server together still connect with a code (no QR)', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium' && !process.env.RUSQ_TRY_WEBKIT, 'WebRTC between two WebKit contexts: best-effort, run with RUSQ_TRY_WEBKIT=1');
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a, srv.url, 'kiran');
  await setup(a, ['keys']);
  await login(b, srv.url, 'asha');
  await setup(b, ['keys']);
  // automatic pairing impossible (as if the phones were never online together)
  for (const c of [ctxA, ctxB]) await c.route('**/api/peer/poll', (r) => r.abort());
  await a.goto(`${srv.url}/nearby`);
  await b.goto(`${srv.url}/nearby`);
  await expect(a.locator('img[alt*="QR"]')).toHaveCount(0); // QR codes are gone
  await a.getByTestId('lan-invite').click();
  const invite = await a.getByTestId('lan-my-code').inputValue({ timeout: 15_000 });
  expect(invite).toMatch(/^[ZJ]/);
  await b.getByTestId('lan-input').fill(invite);
  await b.getByTestId('lan-submit').click();
  await expect(b.getByTestId('lan-my-code')).not.toHaveValue('');
  await a.getByTestId('lan-input').fill(await b.getByTestId('lan-my-code').inputValue());
  await a.getByTestId('lan-submit').click();
  await expect(openLink(a, 'code')).toBeVisible({ timeout: 20_000 });
  await expect(openLink(b, 'code')).toBeVisible();
  await ctxA.close();
  await ctxB.close();
});

test('browser without WebRTC: clear notice, connect disabled, nothing crashes', async ({ page }) => {
  await login(page, srv.url, 'asha');
  await page.goto(`${srv.url}/nearby`);
  const supported = await page.evaluate(() => typeof RTCPeerConnection !== 'undefined');
  test.skip(supported, 'this browser has WebRTC – covered by the link test');
  await expect(page.getByTestId('lan-unsupported')).toContainText(/cannot connect directly/);
  await expect(page.getByTestId('lan-invite')).toBeDisabled();
});
