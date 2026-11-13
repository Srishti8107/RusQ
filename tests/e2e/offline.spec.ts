/**
 * Gate 1 E2E (§9): install/cache online → go offline → app shell from the SW →
 * SOS + report → reload & new tab → data persists, status "queued" → reconnect →
 * "received" ONLY after the server ack. Plus the honesty, kill-tab and quota cases.
 */
import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiLogin, login, setup, startServer, throttleCpu, waitForServiceWorker, FIXTURES, type TestServer } from './helpers.ts';
import { join } from 'node:path';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

async function sendSos(page: Page) {
  await page.goto(`${srv.url}/sos`);
  await page.getByTestId('sos-button').click();
  await expect(page.getByTestId('sos-countdown')).toBeVisible();
  await expect(page.getByTestId('sos-result')).toBeVisible({ timeout: 20_000 });
}

async function makeReport(page: Page) {
  await page.goto(`${srv.url}/report`);
  await expect(page.getByTestId('report-location')).toBeVisible();
  await page.getByRole('button', { name: 'More people' }).click();
  await page.getByRole('button', { name: 'More people' }).click();
  await page.getByRole('button', { name: /Urgency 5/ }).click();
  await page.getByTestId('res-boats').getByRole('checkbox').check();
  await page.getByTestId('res-boats').getByRole('textbox').fill('2');
  await expect(page.getByTestId('claim-boats')).toBeVisible();
  await page.getByTestId('save-report').click();
  await expect(page.getByTestId('report-saved')).toBeVisible();
}

async function statuses(page: Page): Promise<string[]> {
  return page.getByTestId('outbox-row').getByTestId('delivery-status').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')!));
}

test('offline: shell from SW, SOS + report queued, persist across reload/tab, received only after ack', async ({ page, context }) => {
  await throttleCpu(context, page, 4);
  await login(page, srv.url, 'ravi');
  await setup(page, ['shell', 'keys', 'snapshot', 'shelters', 'location']);
  await waitForServiceWorker(page);

  // ---- go offline: the app must still open (served by the service worker)
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('reach')).toHaveText(/Offline/);
  await sendSos(page);
  await expect(page.getByTestId('sos-result').getByTestId('delivery-status')).toHaveAttribute('data-status', 'queued');
  await expect(page.getByTestId('sos-result')).toContainText('Saved on this phone only');
  await makeReport(page);
  await expect(page.getByTestId('report-saved').getByTestId('delivery-status')).toHaveAttribute('data-status', 'queued');

  // ---- reload + a brand-new tab: everything persisted, still queued
  await page.goto(`${srv.url}/outbox`);
  await page.reload();
  await expect(page.getByTestId('outbox-row')).toHaveCount(3); // sos, report, provisional allotment
  expect(await statuses(page)).toEqual(['queued', 'queued', 'queued']);
  const tab2 = await context.newPage();
  await tab2.goto(`${srv.url}/outbox`);
  await expect(tab2.getByTestId('outbox-row')).toHaveCount(3);
  expect(await statuses(tab2)).toEqual(['queued', 'queued', 'queued']);
  await tab2.close();

  // nothing reached the server while offline
  const admin = await apiLogin(srv.url, 'admin');
  expect((await apiGet<unknown[]>(srv.url, '/admin/sos', admin)).length).toBe(0);

  // ---- reconnect; hold the server's response so we can observe "sent" (not received) first
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await context.route('**/api/sync', async (route) => {
    const resp = await route.fetch();
    await gate;
    await route.fulfill({ response: resp });
  });
  await context.setOffline(false);
  await page.getByTestId('sync-now').click({ timeout: 30_000 });
  await expect.poll(() => statuses(page)).toContain('sent');
  expect(await statuses(page)).not.toContain('received');
  release();
  await expect.poll(() => statuses(page), { timeout: 30_000 }).toEqual(['received', 'received', 'received']);
  await expect(page.getByTestId('outbox-row').first()).toContainText(/ref (SOS|RPT|ALT)-\d{6}/);

  // server has exactly one of each
  expect((await apiGet<unknown[]>(srv.url, '/admin/sos', admin)).length).toBe(1);
  expect((await apiGet<unknown[]>(srv.url, '/admin/reports', admin)).length).toBe(1);
});

test.describe('honesty (service worker blocked so EVERY request is intercepted)', () => {
  // With a SW controlling the page, Playwright cannot intercept its requests and Background
  // Sync would reach the real server. Blocking SWs makes the interception airtight; the SW
  // runs the identical syncNow()/applyAck() code (covered by the shared unit/property tests).
  test.use({ serviceWorkers: 'block' });

test('honesty: no ack, forged ack, or mismatched ack never shows received', async ({ page, context }) => {
  await login(page, srv.url, 'asha');
  await setup(page, ['keys']);
  const real = await page.request.get(`${srv.url}/api/server-key`);
  expect(real.ok()).toBe(true);

  let mode: 'empty' | 'forged' | 'mismatch' = 'empty';
  let intercepted = 0;
  const admin = await apiLogin(srv.url, 'admin');
  const sosBefore = (await apiGet<unknown[]>(srv.url, '/admin/sos', admin)).length;
  await context.route('**/api/sync', async (route) => {
    intercepted++;
    const body = route.request().postDataJSON() as { items: { data: { id: string } }[] };
    const id = body.items[0]!.data.id;
    const fake = { clientId: id, kind: 'sos', serverId: 'SOS-999999', receivedAt: new Date().toISOString(), duplicate: false, sig: btoa('x'.repeat(64)) };
    const acks = mode === 'empty' ? [] : mode === 'forged' ? [fake] : [{ ...fake, clientId: '01890000-0000-7000-8000-000000000001' }];
    await route.fulfill({ json: { acks, rejected: [] } });
  });
  // Belt and braces: no other upload path may reach the real server during the fake phase.
  await context.route('**/api/mesh/upload', (route) => route.fulfill({ json: { acks: [], rejected: [] } }));
  await context.route('**/api/photos/**', (route) => route.fulfill({ status: 503, body: 'down' }));
  await sendSos(page);
  for (const m of ['empty', 'forged', 'mismatch'] as const) {
    mode = m;
    await page.goto(`${srv.url}/outbox`);
    await page.getByTestId('sync-now').click();
    await expect(page.getByRole('status').filter({ hasText: /Tried/ })).toBeVisible();
    expect(await statuses(page)).not.toContain('received');
    await expect(page.getByText(/Received by/)).toHaveCount(0);
  }
  expect(intercepted).toBeGreaterThanOrEqual(3); // the fakes really were served
  expect((await apiGet<unknown[]>(srv.url, '/admin/sos', admin)).length).toBe(sosBefore); // nothing reached the server
  // Real server ack → now (and only now) received
  await context.unroute('**/api/sync');
  await context.unroute('**/api/mesh/upload');
  await context.unroute('**/api/photos/**');
  await page.getByTestId('sync-now').click();
  await expect.poll(() => statuses(page)).toEqual(['received']);
});
});

test.describe('kill tab (SW blocked so the in-flight page request is interceptable in every engine)', () => {
  test.use({ serviceWorkers: 'block' });
test('kill the tab mid-sync, then resume: one server record, status received', async ({ context }) => {
  const page = await context.newPage();
  await login(page, srv.url, 'asha');
  await setup(page, ['keys']);
  const admin = await apiLogin(srv.url, 'admin');
  const before = (await apiGet<unknown[]>(srv.url, '/admin/sos', admin)).length;
  // The server processes the request, but the response never reaches the tab.
  let hit!: () => void;
  const reached = new Promise<void>((r) => (hit = r));
  await page.route('**/api/sync', async (route) => {
    await route.fetch();
    hit();
    await new Promise(() => {}); // hang forever
  });
  await sendSos(page);
  await reached;
  await page.close({ runBeforeUnload: false }); // kill the tab mid-sync
  expect((await apiGet<unknown[]>(srv.url, '/admin/sos', admin)).length).toBe(before + 1);

  const again = await context.newPage();
  await again.goto(`${srv.url}/outbox`);
  await again.getByTestId('sync-now').click();
  await expect.poll(() => statuses(again), { timeout: 30_000 }).toContain('received');
  expect((await apiGet<unknown[]>(srv.url, '/admin/sos', admin)).length).toBe(before + 1); // idempotent
});
});

/**
 * Storage full. NOTE (honest): Chromium's DevTools quota override did not make
 * IndexedDB writes fail in this environment, so this is FAULT INJECTION: once
 * armed, IDBObjectStore.put/add throw the browser's real QuotaExceededError
 * DOMException. It proves the app's handling, not a physically full disk.
 */
test('storage full (fault injection): saving shows a clear message, nothing crashes', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __quotaFull?: boolean };
    for (const m of ['put', 'add'] as const) {
      const orig = IDBObjectStore.prototype[m];
      IDBObjectStore.prototype[m] = function (this: IDBObjectStore, ...args: unknown[]) {
        if (w.__quotaFull && (this.name === 'outbox' || this.name === 'photos')) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return (orig as (...a: unknown[]) => IDBRequest).apply(this, args);
      } as never;
    }
  });
  await login(page, srv.url, 'ravi');
  await setup(page, ['keys', 'snapshot', 'location']);
  await page.goto(`${srv.url}/report`);
  await page.getByTestId('photo-input').setInputFiles([join(FIXTURES, 'flooded_street__0babde3d.jpg')]);
  await page.evaluate(() => ((window as unknown as { __quotaFull: boolean }).__quotaFull = true));
  await page.getByTestId('save-report').click();
  await expect(page.getByRole('alert')).toContainText(/out of storage/i);
  await expect(page.getByTestId('save-report')).toBeVisible(); // form still usable, data not lost from screen
  // SOS path too
  await page.goto(`${srv.url}/sos`);
  await page.evaluate(() => ((window as unknown as { __quotaFull: boolean }).__quotaFull = true));
  await page.getByTestId('sos-button').click();
  await expect(page.getByRole('alert')).toContainText(/out of storage/i, { timeout: 20_000 });
});
