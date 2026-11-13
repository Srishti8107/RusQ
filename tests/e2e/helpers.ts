/** E2E helpers: spawn a real server per spec, sign in, run offline setup, CPU throttling. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '../..');

export interface TestServer {
  url: string;
  port: number;
  dbPath: string;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

export async function startServer(): Promise<TestServer> {
  const port = await freePort();
  const dbPath = join(mkdtempSync(join(tmpdir(), 'rusq-e2e-')), 'rusq.db');
  let proc: ChildProcess | null = null;
  const url = `http://localhost:${port}`;

  const launch = async () => {
    proc = spawn(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'apps/server/src/index.ts')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        RUSQ_DB: dbPath,
        RUSQ_STATIC: join(ROOT, 'apps/web/dist'),
        NODE_ENV: 'test',
        RUSQ_RATE_LIMIT: '100000',
        RUSQ_LOGIN_RATE_LIMIT: '1000',
        RUSQ_TEST_USERS: '1', // fixture accounts asha / ravi / meena / kiran – never in a normal start
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr?.on('data', (d) => (err += d));
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${url}/api/health`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`server did not start: ${err}`);
  };
  const stop = async () => {
    if (!proc) return;
    const p = proc;
    proc = null;
    await new Promise<void>((res) => {
      p.once('exit', () => res());
      p.kill();
      setTimeout(res, 3000);
    });
  };
  await launch();
  return { url, port, dbPath, stop, restart: async () => (await stop(), await launch()) };
}

/** Test fixture accounts that are people needing help: they sign in with the user ID only. */
export const VICTIMS = new Set(['asha']);

export async function login(page: Page, url: string, username: string) {
  await page.goto(`${url}/login`);
  await page.getByLabel('Your user ID').fill(username);
  if (!VICTIMS.has(username)) await page.getByLabel(/^Password/).fill('demo1234');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // the control room goes straight to its dashboard (no "Ready for offline")
  await expect(page).toHaveURL(username === 'admin' ? /\/admin$/ : /\/setup/);
}

/** Delivery status of everything in the phone's outbox (read straight from IndexedDB), newest first. */
export async function outboxStatuses(page: Page, kind?: string): Promise<string[]> {
  const rows = await page.evaluate(
    () =>
      new Promise<{ kind: string; status: string; createdAt: string }[]>((res, rej) => {
        const r = indexedDB.open('rusq');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const g = r.result.transaction('outbox', 'readonly').objectStore('outbox').getAll();
          g.onerror = () => rej(g.error);
          g.onsuccess = () => {
            res((g.result as { kind: string; status: string; createdAt: string }[]).map((x) => ({ kind: x.kind, status: x.status, createdAt: x.createdAt })));
            r.result.close();
          };
        };
      }),
  );
  return rows
    .filter((x) => !kind || x.kind === kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((x) => x.status);
}

/** The delivery status of the newest SOS, shown right below the SOS button (Home and /sos). */
export function sosStatus(page: Page) {
  return page.getByTestId('sos-result').getByTestId('delivery-status');
}

/** Runs the given setup items and waits until each is VERIFIED green. */
export async function setup(page: Page, items: string[]) {
  await page.goto(page.url().replace(/\/[^/]*$/, '/setup'));
  for (const id of items) {
    const card = page.getByTestId(`setup-${id}`);
    await expect(card).toBeVisible();
    // Wait for the page's first verification to finish before deciding to click.
    await expect(card).not.toHaveAttribute('data-ok', 'pending', { timeout: 30_000 });
    if ((await card.getAttribute('data-ok')) !== 'yes') {
      const btn = card.getByRole('button', { name: /Download|allow/ });
      await btn.click({ timeout: 10_000 }).catch(() => {}); // may vanish if it verified meanwhile
    }
    await expect(card).toHaveAttribute('data-ok', 'yes', { timeout: id === 'vision' ? 240_000 : 30_000 });
  }
}

export async function waitForServiceWorker(page: Page) {
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
}

/** Low-end phone: 4× CPU slowdown (Chromium only). */
export async function throttleCpu(context: BrowserContext, page: Page, rate = 4) {
  if (context.browser()?.browserType().name() !== 'chromium') return;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

export async function apiLogin(url: string, username: string): Promise<string> {
  const r = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(VICTIMS.has(username) ? { username } : { username, password: 'demo1234' }) });
  return ((await r.json()) as { token: string }).token;
}

export async function apiGet<T>(url: string, path: string, token: string): Promise<T> {
  const r = await fetch(`${url}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
  return (await r.json()) as T;
}

export const FIXTURES = join(ROOT, 'tests/fixtures/vision');
