/**
 * Phase 2 E2E (emulated phones): registration + profile, offline shelter map
 * with last-known location, SOS carries the profile, control-room status
 * reaches the victim, missing-person workflow in the UI, admin screens offline,
 * role guards, the iOS SOS entry, and axe on every Phase 2 screen.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { apiGet, apiLogin, login, setup, sosStatus, startServer, waitForServiceWorker, type TestServer } from './helpers.ts';
import { uuidv7 } from '../../packages/shared/src/index.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

async function apiPost<T>(path: string, token: string, body: unknown, method = 'POST'): Promise<T> {
  const r = await fetch(`${srv.url}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as T;
  if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function register(page: Page, userId: string) {
  await page.goto(`${srv.url}/register`);
  // a user ID is suggested; no username, no password fields (decisions.md 12.2)
  await expect(page.getByLabel(/^User ID/)).toHaveValue(/^np-[a-z0-9]{6}$/);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByLabel(/^User ID/).fill(userId);
  await page.getByLabel('Full name *').fill('Gita Rai');
  await page.getByLabel('Age', { exact: true }).fill('72');
  await page.getByLabel('Total number of people in the house').fill('3');
  await page.getByLabel('Elderly person (65+)').check();
  await page.getByLabel(/^Medical notes for your family/).fill('Blood pressure tablets');
  await page.getByRole('button', { name: /Add a family member to call/ }).click();
  await page.getByLabel('Contact 1 name *').fill('Mohan Rai');
  await page.getByLabel('Contact 1 phone *').fill('+977 00000 12345');
  await page.getByLabel(/^Relation/).fill('son');
  await page.getByLabel(/^Your work/).fill('Farmer');
  await page.getByLabel(/^Where you work/).fill('Sankhu');
  await page.getByTestId('register-submit').click();
  await expect(page).toHaveURL(/\/setup/);
}

test('victim: register online → cache map + shelters → offline map with last-known label → SOS carries profile → team status reaches the victim', async ({ page, context }) => {
  const userId = `gita${Date.now() % 100000}`;
  await register(page, userId);
  await setup(page, ['shell', 'keys', 'map', 'shelters', 'location']);
  await waitForServiceWorker(page);

  // profile is on the server already, and shows the user ID needed to sign in
  await page.goto(`${srv.url}/profile`);
  await expect(page.getByTestId('profile-status')).toContainText('Saved on the server');
  await expect(page.getByTestId('my-user-id')).toHaveText(userId);

  // sign out and back in with the user ID only (no password)
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Your user ID').fill(userId);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/setup/);

  // ---- offline, and location permission gone → last known position with its age
  await context.setOffline(true);
  await context.clearPermissions();
  await page.goto(`${srv.url}/map`);
  await expect(page.getByTestId('reach')).toHaveText(/Offline/);
  await expect(page.locator('[data-testid="map"][data-map-status="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('map-source')).toContainText('from this phone');
  await expect(page.getByTestId('map-last-known')).toContainText(/Last known location, .* ago/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shelters near me');
  await expect(page.getByTestId('shelter-row')).toHaveCount(8); // same district list as the control room
  await expect(page.locator('[data-testid="shelter-row"][data-near="yes"]').first()).toBeVisible(); // nearest ones first
  // tiles really decoded and drawn offline: MapLibre reports rendered road/water features from the PMTiles file
  await expect.poll(async () => Number(await page.getByTestId('map').getAttribute('data-rendered-features')), { timeout: 20_000 }).toBeGreaterThan(50);

  // ---- SOS offline: queued, carries the profile
  await page.goto(`${srv.url}/sos`);
  await page.getByTestId('sos-button').click();
  await expect(page.getByTestId('sos-result')).toBeVisible({ timeout: 20_000 });
  await expect(sosStatus(page)).toHaveAttribute('data-status', 'queued');
  await expect(page.getByTestId('last-known')).toBeVisible();

  // ---- back online → received (only after the ack), sent BY ITSELF – nothing to press
  await context.setOffline(false);
  const sosRow = page.getByTestId('sos-result');
  await expect(sosStatus(page)).toHaveAttribute('data-status', 'received', { timeout: 40_000 });

  // ---- control room sees the profile and assigns a team; the victim sees it
  const admin = await apiLogin(srv.url, 'admin');
  const mon = await apiGet<{ sos: { id: string; profile: { name: string; contacts: { phone: string }[]; needs: string[] }; triage: { level: number } }[] }>(srv.url, '/admin/sos-monitor', admin);
  const mine = mon.sos.find((s) => s.profile?.name === 'Gita Rai')!;
  expect(mine.profile.contacts[0]!.phone).toBe('+977 00000 12345');
  expect(mine.profile.needs).toContain('elderly');
  expect(mine.triage.level).toBeGreaterThanOrEqual(4);
  await apiPost(`/admin/sos/${mine.id}/status`, admin, { status: 'assigned', teamId: 'team-alpha', note: 'Boat on the way' });
  await page.reload();
  await expect(sosRow.getByTestId('ops-status')).toHaveAttribute('data-status', 'assigned', { timeout: 20_000 });
  await expect(sosRow.getByTestId('ops-status')).toContainText('Team Alpha');
});

test('missing person through the UI: family report (queued offline) → admin review → verify → announce; family sees nothing before verified', async ({ browser }) => {
  const fam = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 27.714, longitude: 85.309 } });
  const adm = await browser.newContext();
  const f = await fam.newPage();
  const a = await adm.newPage();
  await login(f, srv.url, 'asha');
  await setup(f, ['shell', 'keys']);
  await waitForServiceWorker(f);

  await fam.setOffline(true);
  await f.goto(`${srv.url}/missing`);
  await f.getByLabel('Their full name *').fill('Rina Shrestha');
  await f.getByLabel('Age').fill('8');
  await f.getByLabel('Gender').selectOption('female');
  await f.getByLabel('What do they look like? What were they wearing?').fill('red frock, school bag');
  await f.getByLabel('Where were they last seen? *').fill('Lainchaur market');
  await f.getByLabel('I am at that place now – add my current location').check();
  await f.getByLabel('Phone number to reach you *').fill('+977 00000 55555');
  await f.getByTestId('missing-submit').click();
  const row = f.getByTestId('missing-row').filter({ hasText: 'Rina Shrestha' });
  await expect(row.getByTestId('delivery-status')).toHaveAttribute('data-status', 'queued');
  await fam.setOffline(false);
  await expect(row.getByTestId('delivery-status')).toHaveAttribute('data-status', 'received', { timeout: 40_000 });

  // admin: the system proposed the sample candidate
  await login(a, srv.url, 'admin');
  await a.goto(`${srv.url}/admin/missing`);
  const card = a.getByTestId('missing-case').filter({ hasText: 'Rina Shrestha' });
  await expect(card).toHaveAttribute('data-state', 'candidate_found');
  await expect(card).toContainText('confidence');
  await expect(card.getByTestId('verify')).toHaveCount(0); // verify is not offered before review
  await expect(card.getByTestId('announce')).toHaveCount(0);

  // family still only sees "reported"
  await f.reload();
  await expect(row.getByTestId('family-status')).toHaveAttribute('data-status', 'reported');
  await expect(row).not.toContainText(/confidence|FP-0|candidate/i);

  await card.getByTestId('start-review').click();
  await expect(card).toHaveAttribute('data-state', 'under_review');
  await card.getByTestId('verify').click(); // checklist empty → refused by the server
  await expect(card.getByRole('alert')).toContainText(/checklist incomplete/);
  await card.getByLabel(/compared every evidence/).check();
  await card.getByLabel(/contacted the shelter/).check();
  await card.getByLabel(/Identity was confirmed/).check();
  await card.getByLabel(/Verification note/).fill('Shelter warden confirmed by phone; mother described the bag.');
  await card.getByTestId('verify').click();
  await expect(card).toHaveAttribute('data-state', 'verified');

  await f.reload();
  await expect(row.getByTestId('family-status')).toHaveAttribute('data-status', 'verified');
  await expect(row.getByTestId('family-status')).toContainText('Lainchaur');
  await f.goto(`${srv.url}/`);
  await expect(f.getByTestId('announcements')).toContainText('No announcements');

  await card.getByTestId('announce').click();
  await expect(card).toHaveAttribute('data-state', 'announced');
  await f.reload();
  await expect(f.getByTestId('announcements')).toContainText('Rina Shrestha');
  await fam.close();
  await adm.close();
});

test('admin: dashboard, SOS monitor, reports, recommendations (approve), CCTV sample, people; offline shows saved data and blocks decisions', async ({ page, context }) => {
  // seed some field data through the real API
  const ravi = await apiLogin(srv.url, 'ravi');
  const rid = uuidv7();
  await apiPost('/sync', ravi, {
    items: [
      {
        kind: 'report',
        data: {
          id: rid,
          teamId: 'team-alpha',
          lat: 27.6941,
          lng: 85.3212,
          locationSource: 'live',
          victimCount: 30,
          urgency: 5,
          notes: 'Water rising fast',
          photos: [],
          requested: { boats: 5, food_water: 200 },
          aiSuggestion: null,
          humanFinal: { hazards: ['flooded street'], victimCount: 30, urgency: 5, requested: { boats: 5, food_water: 200 } },
          createdAt: new Date().toISOString(),
        },
      },
    ],
  });

  await login(page, srv.url, 'admin'); // lands on the dashboard – no "Ready for offline" for the control room
  await expect(page.getByRole('navigation', { name: 'Main' })).not.toContainText('Ready for offline');
  await page.goto(`${srv.url}/setup`);
  await expect(page).toHaveURL(/\/admin$/);
  await waitForServiceWorker(page);
  await page.goto(`${srv.url}/admin`);
  await expect(page.getByTestId('stats')).toContainText('field reports');
  await expect(page.locator('[data-testid="map"][data-map-status="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('areas')).toContainText('CRITICAL');
  await expect(page.getByTestId('resources')).toContainText('Boats');

  await page.goto(`${srv.url}/admin/reports`);
  await expect(page.getByTestId('compare')).toContainText('Boats');
  await expect(page.getByTestId('report-card').first()).toContainText('Water rising fast');

  await page.goto(`${srv.url}/admin/decisions`);
  const first = page.getByTestId('rec-card').filter({ has: page.locator('[data-kind="team_assignment"]') }).first().or(page.locator('[data-testid="rec-card"][data-kind="team_assignment"]').first());
  await expect(first).toBeVisible();
  const before = await page.getByTestId('rec-card').count();
  await first.getByTestId('rec-approve').click();
  await expect(page.getByTestId('rec-decided').first()).toContainText('Approved');
  expect(await page.getByTestId('rec-card').count()).toBe(before - 1);
  // the approved assignment is now a task for that team
  const tasks = await apiGet<{ tasks: unknown[] }>(srv.url, '/team/tasks', ravi);
  const meena = await apiLogin(srv.url, 'meena');
  const kiran = await apiLogin(srv.url, 'kiran');
  const all = [tasks, await apiGet<{ tasks: unknown[] }>(srv.url, '/team/tasks', meena), await apiGet<{ tasks: unknown[] }>(srv.url, '/team/tasks', kiran)];
  expect(all.reduce((n, t) => n + t.tasks.length, 0)).toBe(1);

  await page.goto(`${srv.url}/admin/cctv`);
  await expect(page.getByRole('heading', { name: /CCTV demo/ })).toContainText('SAMPLE DATA');
  await expect(page.locator('canvas.cctv')).toBeVisible();
  await page.goto(`${srv.url}/admin/sos`);
  await page.goto(`${srv.url}/admin/people`);
  await expect(page.getByRole('table')).toContainText('kiran');

  // shelters: the WHOLE district for the control room (not "near you")
  await page.goto(`${srv.url}/map`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shelters in the district');
  await expect(page.getByTestId('shelter-row')).toHaveCount(8);
  await expect(page.getByTestId('district-totals')).toContainText('8 shelters');
  await expect(page.getByTestId('my-location')).toHaveCount(0);

  // ---- offline: saved copies, decisions blocked
  await page.goto(`${srv.url}/admin/decisions`);
  await expect(page.getByTestId('freshness')).toHaveAttribute('data-live', 'yes');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('freshness')).toHaveAttribute('data-live', 'no', { timeout: 20_000 });
  await expect(page.getByTestId('freshness')).toContainText('Offline – showing data saved');
  await expect(page.getByTestId('rec-card').first()).toBeVisible();
  await expect(page.getByTestId('rec-approve').first()).toBeDisabled();
  await page.goto(`${srv.url}/admin`);
  await expect(page.getByTestId('stats')).toBeVisible(); // saved copy; the control room is expected to be online
  await context.setOffline(false);
});

test('role guards in the app: a victim cannot open admin screens and the API refuses admin data', async ({ page }) => {
  await login(page, srv.url, 'asha');
  await page.goto(`${srv.url}/admin/decisions`);
  await expect(page).toHaveURL(`${srv.url}/`);
  await expect(page.getByRole('navigation', { name: 'Main' })).not.toContainText('Recommendations');
  const status = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open('rusq');
      r.onsuccess = () => res(r.result);
    });
    const s = await new Promise<{ value: { token: string } }>((res) => {
      const r = db.transaction('kv').objectStore('kv').get('session');
      r.onsuccess = () => res(r.result);
    });
    return (await fetch('/api/admin/dashboard', { headers: { authorization: `Bearer ${s.value.token}` } })).status;
  });
  expect(status).toBe(403);
});

test('iOS workaround: /sos?source=sos_entry offers a separate SOS manifest whose start_url is the SOS screen', async ({ page }) => {
  await login(page, srv.url, 'asha');
  await page.goto(`${srv.url}/sos?source=sos_entry`);
  await expect(page.getByTestId('sos-entry-help')).toBeVisible();
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/sos.webmanifest');
  const m = await (await fetch(`${srv.url}/sos.webmanifest`)).json();
  expect(m).toMatchObject({ start_url: '/sos?source=sos_entry', id: '/sos-app', short_name: 'SOS' });
  expect(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')).toBe('/icons/sos-apple-touch-icon.png');
  await page.goto(`${srv.url}/`);
  expect(await page.locator('link[rel="manifest"]').getAttribute('href')).not.toBe('/sos.webmanifest');
});

test('accessibility: no serious/critical axe violations on Phase 2 screens', async ({ page }) => {
  const results: Record<string, string[]> = {};
  const scan = async (name: string) => {
    await page.waitForLoadState('networkidle').catch(() => {});
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).exclude('.maplibregl-canvas-container').analyze();
    results[name] = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.length} node(s) – ${v.help} – ${v.nodes[0]?.target}`);
  };
  await page.goto(`${srv.url}/register`);
  await scan('register');
  await login(page, srv.url, 'asha');
  await setup(page, ['map', 'shelters']);
  for (const [name, path] of [
    ['home-victim', '/'],
    ['profile', '/profile'],
    ['map', '/map'],
    ['missing-family', '/missing'],
    ['sos-entry', '/sos?source=sos_entry'],
    ['nearby', '/nearby'],
  ]) {
    await page.goto(`${srv.url}${path}`);
    await scan(name);
  }
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, srv.url, 'admin');
  for (const [name, path] of [
    ['dashboard', '/admin'],
    ['sos-monitor', '/admin/sos'],
    ['reports', '/admin/reports'],
    ['decisions', '/admin/decisions'],
    ['missing-admin', '/admin/missing'],
    ['cctv', '/admin/cctv'],
    ['people', '/admin/people'],
    ['shelters-district', '/map'],
  ]) {
    await page.goto(`${srv.url}${path}`);
    await scan(name);
  }
  console.log('axe-phase2', JSON.stringify(results));
  for (const [name, v] of Object.entries(results)) expect(v, name).toEqual([]);
});

test('AI writing helper is OFF by default and the app works fully without it (template explanation, no helper needed)', async ({ page }) => {
  await login(page, srv.url, 'meena');
  await setup(page, ['keys', 'snapshot']);
  await page.goto(`${srv.url}/settings`);
  await expect(page.getByTestId('assistant-toggle')).not.toBeChecked();
  const gpuText = await page.getByTestId('assistant-gpu').textContent();
  if (/no WebGPU/.test(gpuText ?? '')) await expect(page.getByTestId('assistant-toggle')).toBeDisabled();
  await page.goto(`${srv.url}/report`);
  await expect(page.getByText(/AI writing helper: off/)).toBeVisible();
  await page.getByTestId('res-boats').getByRole('checkbox').check();
  await page.getByTestId('res-boats').getByRole('textbox').fill('3');
  await page.getByTestId('explain-share').click();
  const ex = page.getByTestId('share-explanation');
  await expect(ex).toHaveAttribute('data-source', 'template');
  await expect(ex).toContainText(/boats/i);
  await expect(ex).toContainText('control room makes the final decision');
  // the helper's large worker is not part of the offline precache
  const precached = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((k) => k.startsWith('workbox-precache'));
    const urls: string[] = [];
    for (const n of names) for (const r of await (await caches.open(n)).keys()) urls.push(r.url);
    return urls;
  });
  expect(precached.some((u) => /llm\.worker/.test(u))).toBe(false);
  expect(precached.some((u) => /\/assets\/index-/.test(u))).toBe(true);
});
