/** Amounts on a field report are filled from Indian government relief norms (shared/relief-rates.ts). */
import { expect, test } from '@playwright/test';
import { login, setup, startServer, type TestServer } from './helpers.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

test('ticking a supply fills the amount from the people count; days, typed amounts and boats → first-aid kits', async ({ page }) => {
  await login(page, srv.url, 'ravi');
  await setup(page, ['keys']);
  await page.goto(`${srv.url}/report`);
  await page.locator('#victims').fill('40');

  const qty = (k: string) => page.getByTestId(`res-${k}`).locator('input.qty');
  const tick = (k: string) => page.getByTestId(`res-${k}`).getByRole('checkbox').check();
  for (const k of ['food_water', 'boats', 'first_aid_kits', 'rescue_equipment', 'clothing_blankets', 'medical_supplies']) await tick(k);

  await expect(qty('food_water')).toHaveValue('120'); // 40 × 3 meals × 1 day
  await expect(qty('clothing_blankets')).toHaveValue('40');
  await expect(qty('rescue_equipment')).toHaveValue('40'); // 1 life jacket each
  await expect(qty('boats')).toHaveValue('10'); // 4 people per boat per trip
  await expect(qty('first_aid_kits')).toHaveValue('11'); // 1 per boat + 1 for the site
  await expect(qty('medical_supplies')).toHaveValue('1');
  await expect(page.getByTestId('why-medical_supplies')).toContainText('No per-person government rate');
  await expect(page.getByTestId('why-boats')).toContainText('NDMA Boat Safety Guidelines 2017');
  await expect(page.getByTestId('relief-water')).toContainText('120 litres');

  // More days → more food and water; boats and life jackets stay.
  await page.getByRole('button', { name: 'More days' }).click();
  await expect(qty('food_water')).toHaveValue('240');
  await expect(page.getByTestId('relief-water')).toContainText('240 litres');
  await expect(qty('boats')).toHaveValue('10');

  // The people count changes (e.g. the rescuer recounts) → ticked amounts follow.
  await page.locator('#victims').fill('8');
  await expect(qty('food_water')).toHaveValue('48');
  await expect(qty('boats')).toHaveValue('2');
  await expect(qty('first_aid_kits')).toHaveValue('3');

  // A typed amount is kept; first-aid kits follow the boats actually asked for.
  await qty('boats').fill('5');
  await expect(qty('first_aid_kits')).toHaveValue('6');
  await page.locator('#victims').fill('12');
  await expect(qty('boats')).toHaveValue('5');
  await expect(page.getByTestId('why-boats')).toContainText('You entered 5. Government norm: 3');
  await page.getByTestId('why-boats').getByRole('button', { name: 'Use 3' }).click();
  await expect(qty('boats')).toHaveValue('3');
  await page.locator('#victims').fill('16');
  await expect(qty('boats')).toHaveValue('4'); // follows the norm again
  await page.getByTestId('res-boats').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('relief-norms.png'), fullPage: true });
});
