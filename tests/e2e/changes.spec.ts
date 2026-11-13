/**
 * Owner's change list of 2026-11-13 (decisions.md section 12), tested in emulation:
 *  12.1  the Online/Offline badge does not flip on one slow answer, and recovers quickly
 *  12.3  an HTML error page from a proxy/tunnel ("<!DOCTYPE …") is never shown to people
 *  12.6  no text sticks out of its button/box on any screen at phone width (360 px)
 *  12.7  a video file can be analysed on the CCTV page (MOCK detector here – real models are
 *        covered by the vision tests)
 *  12.11 the SOS circle is the first thing on Home for people needing help and rescuers
 *  12.12 a notification says when a delayed SOS finally reached the control room
 */
import { expect, test, type Page } from '@playwright/test';
import { login, setup, sosStatus, startServer, type TestServer } from './helpers.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

/** Every visible text box whose content is wider than the box, or that sticks out of the screen. */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const sel = 'a, button, .pill, .status, label, legend, h1, h2, h3, .banner, .card, .big-action, .nav a, .tabs button, p, li, strong';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (el.closest('.table-wrap, .maplibregl-map, canvas, textarea, svg, .mono')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!text) continue;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible') out.push(`text wider than its box: "${text}" (${el.scrollWidth} > ${el.clientWidth})`);
      if (r.right > vw + 1) out.push(`off the screen: "${text}" (right edge ${Math.round(r.right)} > ${vw})`);
    }
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
    return [...new Set(out)];
  });
}

test('12.6: on every screen, at 360 px phone width, button and box labels stay inside their boxes', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  const bad: Record<string, string[]> = {};
  const check = async (role: string, paths: string[]) => {
    for (const p of paths) {
      await page.goto(`${srv.url}${p}`);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
      const o = await overflowing(page);
      if (o.length) bad[`${role} ${p}`] = o;
    }
  };
  await page.goto(`${srv.url}/register`);
  const reg = await overflowing(page);
  if (reg.length) bad['register'] = reg;
  await login(page, srv.url, 'asha');
  await check('victim', ['/', '/sos', '/map', '/missing', '/profile', '/nearby', '/setup', '/settings']);
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, srv.url, 'ravi');
  await check('rescuer', ['/', '/report', '/nearby']);
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, srv.url, 'admin');
  await check('admin', ['/', '/admin', '/admin/sos', '/admin/reports', '/admin/decisions', '/admin/reconcile', '/admin/missing', '/admin/cctv', '/admin/people', '/map', '/settings']);
  // the label the owner pointed at
  const rec = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Recommendations' });
  expect(await rec.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  console.log('overflow', JSON.stringify(bad));
  expect(bad).toEqual({});
});

test('12.11: Home – the big SOS circle comes first, everything else after it', async ({ page }) => {
  await login(page, srv.url, 'asha');
  await page.goto(`${srv.url}/`);
  const sos = await page.getByTestId('sos-button').boundingBox();
  const firstAction = await page.locator('.big-action').first().boundingBox();
  const nav = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
  expect(sos!.y).toBeLessThan(firstAction!.y);
  expect(sos!.y).toBeLessThan(nav!.y); // the menu moved below the page on Home
  expect(sos!.width).toBeGreaterThan(200); // a big circle
  // no "Sent & waiting" anywhere
  await expect(page.getByText('Sent & waiting')).toHaveCount(0);
  await page.goto(`${srv.url}/outbox`);
  await expect(page).toHaveURL(`${srv.url}/`);
});

test.describe('badge (service worker blocked: WebKit cannot intercept requests that pass through a service worker)', () => {
test.use({ serviceWorkers: 'block' });
test('12.1 + 12.3: one slow answer does not flip the badge; a tunnel error page means Offline and is never shown', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __reach: string[] };
    w.__reach = [];
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="reach"]')?.textContent ?? '';
      if (w.__reach.at(-1) !== t) w.__reach.push(t);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await login(page, srv.url, 'asha');
  await page.goto(`${srv.url}/`);
  await expect(page.getByTestId('reach')).toHaveText(/Online/);

  // ONE slow health answer (longer than the 6 s check timeout), then normal again
  let slow = 1;
  await page.route('**/api/health*', async (route) => {
    if (slow-- > 0) await new Promise((r) => setTimeout(r, 7000));
    await route.continue().catch(() => {});
  });
  await page.evaluate(() => (window as unknown as { __reach: string[] }).__reach.splice(0));
  await page.evaluate(() => window.dispatchEvent(new Event('offline'))); // the browser "thinks" the network dropped
  await page.waitForTimeout(10_000);
  expect(await page.evaluate(() => (window as unknown as { __reach: string[] }).__reach.filter((t) => /Offline/.test(t)))).toEqual([]);
  await expect(page.getByTestId('reach')).toHaveText(/Online/);
  await page.unroute('**/api/health*');

  // the HTTPS tunnel can no longer reach the server: every /api answer is an HTML error page
  const errorPage = '<!DOCTYPE html><html><head><title>502 Bad gateway</title></head><body><h1>Bad gateway</h1></body></html>';
  await page.route('**/api/**', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: errorPage }));
  await expect(page.getByTestId('reach')).toHaveText(/Offline/, { timeout: 20_000 });
  await page.getByTestId('sos-button').click();
  await expect(sosStatus(page)).toHaveAttribute('data-status', 'queued', { timeout: 20_000 });
  await page.waitForTimeout(6000); // let the automatic sending try (and fail) a few times
  await expect(page.locator('body')).not.toContainText(/DOCTYPE|<html|Bad gateway/i);
  // and back: no page load, no button – it notices by itself and sends the SOS
  await page.unroute('**/api/**');
  await expect(page.getByTestId('reach')).toHaveText(/Online/, { timeout: 15_000 });
  await expect(sosStatus(page)).toHaveAttribute('data-status', 'received', { timeout: 30_000 });
});
});

test('12.3: admin screens never show a raw error page either', async ({ page }) => {
  await login(page, srv.url, 'admin');
  await page.route('**/api/admin/**', (route) => route.fulfill({ status: 530, contentType: 'text/html', body: '<!DOCTYPE html><html><body>Origin unreachable</body></html>' }));
  for (const p of ['/admin/decisions', '/admin/sos', '/admin/people']) {
    await page.goto(`${srv.url}${p}`);
    await page.waitForTimeout(1500);
    await expect(page.locator('body')).not.toContainText(/DOCTYPE|<html|Origin unreachable/i);
  }
});

test('12.7: CCTV – a video file is analysed on this computer and summarised (advisory)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the test video is recorded with MediaRecorder (WebM) in Chromium');
  await login(page, srv.url, 'admin');
  await page.goto(`${srv.url}/settings`);
  await page.getByLabel(/Photo helper MOCK mode/).check(); // fast, deterministic detector for this UI test
  // record a short synthetic clip in the browser (no real footage in the repo)
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    const ctx = c.getContext('2d')!;
    const rec = new MediaRecorder(c.captureStream(10), { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start(200);
    for (let i = 0; i < 50; i++) {
      ctx.fillStyle = i < 25 ? '#3a6ea5' : '#7a5c3a';
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = '#fff';
      ctx.fillRect(10 + i * 4, 100, 30, 60);
      await new Promise((r) => setTimeout(r, 100));
    }
    rec.stop();
    await new Promise((r) => (rec.onstop = r));
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  await page.goto(`${srv.url}/admin/cctv`);
  await expect(page.getByTestId('footage')).toContainText('The video stays on this computer');
  await page.getByTestId('footage-file').setInputFiles({ name: 'street.webm', mimeType: 'video/webm', buffer: Buffer.from(b64, 'base64') });
  const summary = page.getByTestId('footage-summary');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => Number(await summary.getAttribute('data-frames')), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('footage-people')).toContainText('People visible at most');
  await expect(page.getByTestId('footage')).toContainText('MOCK mode'); // honest label
});

test.describe('notification (service worker blocked so the page sends; Notification replaced by a recorder)', () => {
  // HONEST NOTE: headless browsers refuse notifications even with permission granted, so the
  // browser's Notification is replaced by a recorder. This proves WHEN and WITH WHAT TEXT the app
  // notifies; that a phone really displays it is a real-device check (PHONE_TEST.md row 31).
  test.use({ serviceWorkers: 'block' });
  test('12.12: when a delayed SOS reaches the control room, the phone notifies once; an SOS sent at once does not', async ({ page, context }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __notes: string[]; Notification: unknown };
      w.__notes = [];
      class FakeNotification {
        static permission = 'granted';
        static requestPermission = async () => 'granted';
        constructor(title: string, opts?: { body?: string }) {
          w.__notes.push(`${title} | ${opts?.body ?? ''}`);
        }
      }
      w.Notification = FakeNotification;
    });
    await login(page, srv.url, 'asha');
    await setup(page, ['keys']);
    await page.goto(`${srv.url}/`);
    const notes = () => page.evaluate(() => (window as unknown as { __notes: string[] }).__notes);

    // sent at once → the message under the button is enough, no notification
    await page.getByTestId('sos-button').click();
    await expect(sosStatus(page)).toHaveAttribute('data-status', 'received', { timeout: 30_000 });
    await page.waitForTimeout(1000);
    expect(await notes()).toEqual([]);

    // offline → delivered later → exactly one notification with the reference
    await context.setOffline(true);
    await expect(page.getByTestId('reach')).toHaveText(/Offline/, { timeout: 20_000 });
    await page.getByTestId('sos-button').click();
    await expect(sosStatus(page)).toHaveAttribute('data-status', 'queued', { timeout: 20_000 });
    await page.waitForTimeout(11_000); // "could not be sent at once"
    await context.setOffline(false);
    await expect(sosStatus(page)).toHaveAttribute('data-status', 'received', { timeout: 40_000 });
    await expect.poll(notes, { timeout: 20_000 }).toEqual([expect.stringMatching(/Your SOS reached the control room \| Reference SOS-\d{6}/)]);
    await page.waitForTimeout(6000); // later sync rounds do not repeat it
    expect(await notes()).toHaveLength(1);
  });
});
