/** Website = control room only (default): field roles are sent to the Android app; the control room works as before. */
import { expect, test } from '@playwright/test';
import { startServer, type TestServer } from './helpers.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer({ RUSQ_WEB_FIELD_ROLES: '0', RUSQ_APK: 'does-not-exist.apk' });
});
test.afterAll(async () => {
  await srv.stop();
});

test('rescuers and people needing help get the "install the app" page on the website; the control room signs in normally', async ({ page }) => {
  const cfg = await (await fetch(`${srv.url}/api/config`)).json();
  expect(cfg).toEqual({ webFieldRoles: false, apk: null });

  await page.goto(`${srv.url}/login`);
  await expect(page.getByTestId('web-admin-only')).toBeVisible();
  await page.goto(`${srv.url}/register`);
  await expect(page.getByTestId('get-app')).toBeVisible();

  // a rescuer signs in → app page, no menu, can sign out
  await page.goto(`${srv.url}/login`);
  await page.getByLabel('Your user ID').fill('ravi');
  await page.getByLabel(/^Password/).fill('demo1234');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('get-app')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out' }).click();

  // the control room
  await page.getByLabel('Your user ID').fill('admin');
  await page.getByLabel(/^Password/).fill('demo1234');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId('get-app')).toHaveCount(0);

  // the Android app's origin may call the API (CORS); other sites may not
  const ok = await fetch(`${srv.url}/api/health`, { headers: { origin: 'https://localhost' } });
  expect(ok.headers.get('access-control-allow-origin')).toBe('https://localhost');
  const other = await fetch(`${srv.url}/api/health`, { headers: { origin: 'https://evil.example' } });
  expect(other.headers.get('access-control-allow-origin')).toBeNull();
});
