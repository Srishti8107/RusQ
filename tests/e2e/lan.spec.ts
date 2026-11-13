/**
 * EXPERIMENTAL LAN peer link (§9): two browser contexts exchange a report over a
 * real WebRTC data channel (host candidates only, copy-paste signalling) WITH THE
 * SERVER STOPPED. Then the server comes back, phone B acts as gateway, and the
 * server ack travels back over the link so phone A shows "received".
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

async function makeReport(page: Page) {
  await page.goto(`${srv.url}/report`);
  await expect(page.getByTestId('report-location')).toBeVisible();
  await page.getByRole('button', { name: 'More people' }).click();
  await page.getByTestId('save-report').click();
  await expect(page.getByTestId('report-saved')).toBeVisible();
  return page.url();
}

test('two phones exchange a report over the LAN link while the server is down; ack returns over the link', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium' && !process.env.RUSQ_TRY_WEBKIT, 'WebRTC between two WebKit contexts: best-effort, run with RUSQ_TRY_WEBKIT=1');
  const ctxA = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 26.16, longitude: 91.78 } });
  const ctxB = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 26.17, longitude: 91.77 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a, srv.url, 'ravi');
  await setup(a, ['keys', 'snapshot', 'location']);
  await waitForServiceWorker(a);
  await login(b, srv.url, 'meena');
  await setup(b, ['keys', 'snapshot']);
  await waitForServiceWorker(b);

  // ---- server goes down
  await srv.stop();
  await makeReport(a);
  await a.goto(`${srv.url}/outbox`);
  const reportId = await a.getByTestId('outbox-row').filter({ hasText: 'Field report' }).getAttribute('data-id');
  expect(reportId).toBeTruthy();
  await expect(a.getByTestId('outbox-row').first().getByTestId('delivery-status')).toHaveAttribute('data-status', 'queued');

  // ---- copy-paste signalling
  await a.goto(`${srv.url}/nearby`);
  await b.goto(`${srv.url}/nearby`);
  await a.getByTestId('lan-invite').click();
  const invite = await a.getByTestId('lan-my-code').inputValue({ timeout: 15_000 });
  expect(invite).toMatch(/^[ZJ]/);
  await b.getByTestId('lan-input').fill(invite);
  await b.getByTestId('lan-submit').click();
  await expect(b.getByTestId('lan-my-code')).not.toHaveValue('');
  const reply = await b.getByTestId('lan-my-code').inputValue();
  await a.getByTestId('lan-input').fill(reply);
  await a.getByTestId('lan-submit').click();
  await expect(a.getByTestId('lan-peer')).toHaveAttribute('data-state', 'open', { timeout: 20_000 });
  await expect(b.getByTestId('lan-peer')).toHaveAttribute('data-state', 'open');

  // ---- B now carries A's report (store-and-forward); A's status is 'sent', never 'received'
  await expect(b.locator(`[data-testid="lan-held-item"][data-id="${reportId}"]`)).toBeVisible({ timeout: 20_000 });
  const aOutbox = await ctxA.newPage(); // second tab: the link stays alive in the first one
  const reportStatus = () => aOutbox.getByTestId('outbox-row').filter({ hasText: 'Field report' }).getByTestId('delivery-status');
  await aOutbox.goto(`${srv.url}/outbox`);
  await expect(reportStatus()).toHaveAttribute('data-status', 'sent');

  // ---- server back. A's own direct path stays blocked, so the ack can ONLY come back via B.
  await ctxA.route('**/api/**', (r) => r.abort());
  await srv.restart();
  await expect(b.getByTestId('reach')).toHaveText(/Online/, { timeout: 40_000 });
  // B's sync scheduler usually uploads automatically once online; the button is only a manual nudge.
  await b.getByRole('button', { name: 'Upload for the other phones now' }).click({ timeout: 5000 }).catch(() => {});
  const admin = await apiLogin(srv.url, 'admin');
  await expect
    .poll(async () => (await apiGet<{ id: string; via: string }[]>(srv.url, '/admin/reports', admin)).map((r) => `${r.id}:${r.via}`), { timeout: 30_000 })
    .toContain(`${reportId}:relay`);
  // the signed server ack travels B → A over the LAN link → A shows received
  await aOutbox.reload();
  await expect(reportStatus()).toHaveAttribute('data-status', 'received', { timeout: 30_000 });
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
