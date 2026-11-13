/** Control room sends teams to locations by priority; the team sees it on Home and reports progress. */
import { expect, test } from '@playwright/test';
import { login, startServer, type TestServer } from './helpers.ts';

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer();
});
test.afterAll(async () => {
  await srv.stop();
});

test('admin assigns a priority area and a map point to teams; the team sees them by priority and reports progress', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const raviCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const ravi = await raviCtx.newPage();

  await login(admin, srv.url, 'admin');
  await admin.goto(`${srv.url}/admin/assignments`);

  // 1. From the top priority area (seeded flood data), low priority on purpose.
  const area = admin.getByTestId('asg-area').first();
  await expect(area).toBeVisible();
  await area.getByRole('button', { name: /Assign a team here/ }).click();
  await expect(admin.getByTestId('asg-place')).not.toHaveValue('');
  await admin.getByTestId('asg-team').selectOption('team-alpha');
  await admin.getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'Low' }).click();
  await admin.getByTestId('asg-submit').click();
  await expect(admin.getByTestId('asg-saved')).toContainText('Team Alpha was sent to');

  // 2. A typed point, critical.
  await admin.getByTestId('asg-lat').fill('27.7001');
  await admin.getByTestId('asg-lng').fill('85.3201');
  await admin.getByTestId('asg-place').fill('Riverside houses');
  await admin.getByTestId('asg-team').selectOption('team-alpha');
  await admin.getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'Critical' }).click();
  await admin.getByTestId('asg-instructions').fill('Two elderly people on the roof');
  await admin.getByTestId('asg-submit').click();
  await expect(admin.getByTestId('asg-saved')).toContainText('Riverside houses (Critical priority)');

  await expect(admin.getByTestId('asg-card')).toHaveCount(2);
  await expect(admin.getByTestId('asg-card').first()).toHaveAttribute('data-priority', 'critical'); // highest first
  await expect(admin.locator('[data-testid="asg-team-row"][data-team="team-alpha"]')).toContainText('2');

  // 3. The team sees both, critical first.
  await login(ravi, srv.url, 'ravi');
  await ravi.goto(`${srv.url}/`);
  const cards = ravi.getByTestId('team-assignment');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toHaveAttribute('data-priority', 'critical');
  await expect(cards.first()).toContainText('Riverside houses');
  await expect(cards.first()).toContainText('Two elderly people on the roof');
  await cards.first().getByRole('button', { name: /on our way/ }).click();
  await expect(cards.first()).toHaveAttribute('data-status', 'in_progress');

  // 4. The control room gets a pop-up and the list refreshes.
  await expect(admin.getByTestId('toast').filter({ hasText: 'Team Alpha is on the way to Riverside houses' })).toBeVisible({ timeout: 20_000 });
  await expect(admin.getByTestId('asg-card').first()).toHaveAttribute('data-status', 'in_progress');

  // 5. Done with a note → it leaves the team's list; the admin sees the note.
  await cards.first().getByPlaceholder(/12 people/).fill('Both people at the school');
  await cards.first().getByRole('button', { name: /Done/ }).click();
  await expect(cards).toHaveCount(1);
  await expect(admin.getByTestId('toast').filter({ hasText: 'Team Alpha finished: Riverside houses' })).toBeVisible({ timeout: 20_000 });
  await admin.getByRole('group', { name: 'Filter assignments' }).getByRole('button', { name: /Done/ }).click();
  await expect(admin.getByTestId('asg-card').first()).toContainText('Both people at the school');

  // 6. Admin raises the remaining one to high and moves it to Team Bravo.
  await admin.getByRole('group', { name: 'Filter assignments' }).getByRole('button', { name: /Active/ }).click();
  const rest = admin.getByTestId('asg-card').first();
  await rest.getByLabel(/^Priority of/).selectOption('high');
  await expect(rest).toHaveAttribute('data-priority', 'high');
  await rest.getByLabel(/^Team of/).selectOption('team-bravo');
  await expect(admin.getByTestId('asg-card').first()).toHaveAttribute('data-team', 'team-bravo');
  await ravi.reload();
  await expect(ravi.getByTestId('team-assignment')).toHaveCount(0);
  await admin.screenshot({ path: test.info().outputPath('assignments-admin.png'), fullPage: true });

  await adminCtx.close();
  await raviCtx.close();
});
