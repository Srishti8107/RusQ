/**
 * Playwright – emulated phone tests (§5, §9). Every spec starts its OWN server
 * (fresh SQLite DB) so tests can stop/restart it (LAN test with server down).
 *
 * Projects
 *   pixel  – Chromium, Pixel 7 profile, 4× CPU throttling (CDP) → primary target
 *   iphone – WebKit, iPhone 13 profile (best effort, like the product)
 *
 * Emulation ≠ real phones. Real-device results go in docs/PHONE_TEST.md.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    { name: 'pixel', use: { ...devices['Pixel 7'], permissions: ['geolocation'], geolocation: { latitude: 26.1612, longitude: 91.7795 } } },
    { name: 'iphone', use: { ...devices['iPhone 13'], permissions: ['geolocation'], geolocation: { latitude: 26.1612, longitude: 91.7795 } } },
  ],
});
