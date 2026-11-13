/**
 * Rescuer short codes, end to end in real browsers:
 * Ravi (no internet) saves a report → gets the SMS code → Meena pastes it (as if it came by SMS)
 * → it reaches the control room as a SHORT CODE report → Ravi's full report arrives later and
 * replaces it under the same RPT number.
 */
import { expect, test } from '@playwright/test';
import { apiGet, apiLogin, login, setup, startServer, type TestServer } from './helpers.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

type Row = { id: string; serverId: string; via: string; teamId: string; relayHops: number | null; relayGateway: string | null; shortCodeAt: string | null; notes: string; humanFinal: { victimCount: number; requested: Record<string, number> } };

test('short code: offline report → SMS code → another rescuer passes it on → control room; full report replaces it later', async ({ browser }) => {
  const a = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 27.6912, longitude: 85.3195 } });
  const b = await browser.newContext();
  const ravi = await a.newPage();
  const meena = await b.newPage();

  await login(ravi, srv.url, 'ravi');
  await setup(ravi, ['keys']);
  await ravi.goto(`${srv.url}/settings`);
  // type the numbers and check they survive a reload (WebKit saves to IndexedDB a little later)
  await expect(async () => {
    await ravi.getByTestId('sms-numbers').fill('+910000000001, +910000000002');
    await ravi.waitForTimeout(300);
    await ravi.reload();
    await expect(ravi.getByTestId('sms-numbers')).toHaveValue('+910000000001, +910000000002', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await ravi.goto(`${srv.url}/report`);
  await expect(ravi.getByTestId('report-location')).toBeVisible();

  await a.setOffline(true); // no internet from here on
  await ravi.locator('#victims').fill('40');
  await ravi.getByTestId('res-food_water').locator('input.qty').fill('20');
  await ravi.getByTestId('res-boats').locator('input.qty').fill('2');
  await ravi.getByTestId('save-report').click();
  await expect(ravi.getByTestId('report-saved')).toBeVisible();

  const code = (await ravi.getByTestId('shortcode-text').textContent())!;
  expect(code).toMatch(/^RQ1 Tteam-alpha G\w{8} P40 U3 NF20B2 D\w{5} R\w{6} H0 X\w{8}$/);
  expect(code.length).toBeLessThanOrEqual(160);
  const href = await ravi.getByTestId('shortcode-sms').getAttribute('href');
  expect(href).toBe(`sms:+910000000001,+910000000002?body=${encodeURIComponent(code)}`);

  // Meena got the SMS and pastes it.
  await login(meena, srv.url, 'meena');
  await setup(meena, ['keys']);
  await meena.goto(`${srv.url}/codes`);
  await meena.getByTestId('code-input').fill(`From Ravi: ${code}`);
  await meena.getByTestId('code-add').click();
  await expect(meena.getByTestId('code-result')).toContainText('team-alpha: 40 people, urgency 3, needs 20 food and water, 2 boats (hop 1)');
  await expect(meena.getByTestId('code-row').first()).toHaveAttribute('data-status', 'uploaded', { timeout: 30_000 });
  await meena.screenshot({ path: test.info().outputPath('codes-page.png') });

  const admin = await apiLogin(srv.url, 'admin');
  const viaCode = (await apiGet<Row[]>(srv.url, '/admin/reports', admin)).filter((r) => r.via === 'code');
  expect(viaCode).toHaveLength(1);
  expect(viaCode[0]).toMatchObject({ teamId: 'team-alpha', relayHops: 1, relayGateway: 'meena', humanFinal: { victimCount: 40, requested: { food_water: 20, boats: 2 } } });
  const serverId = viaCode[0]!.serverId;

  // Ravi gets internet back: the full report replaces the code under the same number.
  await a.setOffline(false);
  await expect
    .poll(async () => (await apiGet<Row[]>(srv.url, '/admin/reports', admin)).find((r) => r.serverId === serverId)?.via, { timeout: 60_000 })
    .toBe('direct');
  const rows = await apiGet<Row[]>(srv.url, '/admin/reports', admin);
  expect(rows.filter((r) => r.serverId === serverId)).toHaveLength(1);
  expect(rows.find((r) => r.serverId === serverId)!.shortCodeAt).not.toBeNull();

  await a.close();
  await b.close();
});
