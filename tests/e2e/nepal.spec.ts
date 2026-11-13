/** Newest SOS first; real Nepal background data on the dashboard and SOS cards. */
import { expect, test } from '@playwright/test';
import { apiGet, apiLogin, login, startServer, type TestServer } from './helpers.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

test('SOS monitor lists the newest SOS first; dashboard shows real Nepal layers and the official 2024 figures', async ({ page }) => {
  const asha = await apiLogin(srv.url, 'asha');
  const me = await apiGet<{ user: { id: string } }>(srv.url, '/me', asha);
  const send = (id: string, lat: number, lng: number, minAgo: number) =>
    fetch(`${srv.url}/api/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${asha}`, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ kind: 'sos', data: { id, userId: me.user.id, lat, lng, accuracy: 20, locationSource: 'live', createdAt: new Date(Date.now() - minAgo * 60_000).toISOString(), source: 'app' } }] }),
    });
  // older one sent first, then a newer one (both arrive now; arrival order decides)
  await send('01900000-0000-7000-8000-0000000000a1', 27.7115, 85.3175, 30);
  await new Promise((r) => setTimeout(r, 1100));
  await send('01900000-0000-7000-8000-0000000000a2', 27.6912, 85.3192, 1);

  await login(page, srv.url, 'admin');
  await page.goto(`${srv.url}/admin/sos`);
  const cards = page.getByTestId('sos-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText(/Received/);
  await expect(cards.first().getByTestId('sos-new')).toBeVisible();
  // the newest arrival (Thapathali riverside) is first and shows the real context
  await expect(cards.first().getByTestId('sos-context')).toContainText('Nearest hospital');
  await expect(cards.first().getByTestId('sos-context')).toContainText('low-lying land next to a river');

  await page.goto(`${srv.url}/admin`);
  const ref = page.getByTestId('nepal-reference');
  await expect(ref).toContainText('250');
  await expect(ref).toContainText('239.7 mm');
  await expect(page.getByTestId('nepal-exposure')).toContainText('people live in this map region');
  await expect(page.getByText('Flood-prone land near rivers (terrain model')).toBeVisible();
  await expect(page.getByText('Rivers (OpenStreetMap)')).toBeVisible();
  await expect(page.getByTestId('areas')).toContainText('Residents (est.)');
  await page.getByText(/Hospitals \(OpenStreetMap – real/).click();
  await page.screenshot({ path: test.info().outputPath('dashboard-nepal.png'), fullPage: true });
});
