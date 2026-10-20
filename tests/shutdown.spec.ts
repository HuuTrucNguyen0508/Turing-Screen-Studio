import { expect, test } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';
import { chooseMenu } from './menus';

test.use({ baseURL: 'http://127.0.0.1:4176' });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/layout', (route) => route.fulfill({ json: { document: createSampleLayout(), revision: 'shutdown-fixture' } }));
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, appliedRevision: 'shutdown-fixture' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Use HTML preview' } }));
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 740 }]) {
  test(`confirm, cancel and stop Studio at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let shutdowns = 0;
    let statusRequests = 0;
    page.on('request', (request) => { if (request.url().endsWith('/api/status')) statusRequests++; });
    await page.route('**/api/shutdown', (route) => {
      expect(route.request().method()).toBe('POST');
      shutdowns++;
      return route.fulfill({ status: 202, json: { status: 'stopping' } });
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeVisible();
    await page.getByRole('group', { name: 'CPU load card' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Shut down Studio…' })).toBeVisible();
    const menuBounds = await page.getByRole('menu', { name: 'Settings' }).boundingBox();
    expect(menuBounds?.x).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: `artifacts/ui-simplify/shutdown-menu-${viewport.width}.png` });
    await page.getByRole('menuitem', { name: 'Shut down Studio…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Shut down Studio?' });
    await expect(dialog).toContainText('Ctrl+F9–F12 layout shortcuts stop working until Studio starts again');
    await expect(dialog).toContainText('The panel keeps showing its current layout');
    await expect(dialog).toContainText('You have unsaved changes. They stay in draft recovery in this browser');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.screenshot({ path: `artifacts/ui-simplify/shutdown-dialog-${viewport.width}.png` });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(shutdowns).toBe(0);
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
    await chooseMenu(page, 'Settings', 'Shut down Studio…');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(shutdowns).toBe(0);
    await chooseMenu(page, 'Settings', 'Shut down Studio…');
    await dialog.getByRole('button', { name: 'Shut down Studio', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Studio is stopped' })).toBeVisible();
    expect(shutdowns).toBe(1);
    await expect(page.getByText('systemctl --user start turzx-studio.service', { exact: true })).toBeVisible();
    await expect(page.getByText('pnpm studio', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy service command' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy pnpm command' })).toBeVisible();
    const stoppedBounds = await page.getByRole('heading', { name: 'Studio is stopped' }).boundingBox();
    expect(stoppedBounds?.x).toBeGreaterThanOrEqual(20);
    await page.screenshot({ path: `artifacts/ui-simplify/shutdown-stopped-${viewport.width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy service command' }).click();
    await expect(page.getByRole('status')).toHaveText('Copied systemctl --user start turzx-studio.service');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('systemctl --user start turzx-studio.service');
    await expect(page.getByRole('button', { name: 'Copy service command' })).toBeFocused();
    await page.getByRole('button', { name: 'Copy pnpm command' }).click();
    await expect(page.getByRole('status')).toHaveText('Copied pnpm studio');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('pnpm studio');
    const stoppedRequests = statusRequests;
    await page.waitForTimeout(1800);
    expect(statusRequests).toBe(stoppedRequests);
    await page.route('**/api/status', (route) => route.abort());
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Studio is not answering yet');
    await page.unroute('**/api/status');
    const navigation = page.waitForEvent('load');
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await navigation;
    await expect(page.getByRole('dialog', { name: 'Recover a draft' })).toBeVisible();
    await page.getByRole('button', { name: 'Restore draft', exact: true }).first().click();
    await expect(page.getByLabel('X position')).toHaveValue('65');
  });
}

test('shutdown is hidden in the offline editor', async ({ page }) => {
  await page.route('**/api/layout', (route) => route.fulfill({ status: 404 }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Shut down Studio…' })).toHaveCount(0);
});

test('a failed draft backup prevents shutdown', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('turzx-studio:recovery:v1:')) throw new DOMException('Storage is full', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  let shutdowns = 0;
  await page.route('**/api/shutdown', (route) => { shutdowns++; return route.fulfill({ status: 202 }); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  await chooseMenu(page, 'Settings', 'Shut down Studio…');
  const dialog = page.getByRole('dialog', { name: 'Shut down Studio?' });
  await dialog.getByRole('button', { name: 'Shut down Studio', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your draft could not be backed up');
  expect(shutdowns).toBe(0);
});

for (const failure of ['forbidden', 'network']) {
  test(`shutdown handles ${failure} failure`, async ({ page }) => {
    await page.route('**/api/shutdown', (route) => failure === 'network' ? route.abort() : route.fulfill({ status: 403, json: { error: 'Forbidden' } }));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeVisible();
    await chooseMenu(page, 'Settings', 'Shut down Studio…');
    const dialog = page.getByRole('dialog', { name: 'Shut down Studio?' });
    await expect(dialog).not.toContainText('You have unsaved changes');
    await dialog.getByRole('button', { name: 'Shut down Studio', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(failure === 'network' ? 'Could not confirm shutdown' : 'Studio refused');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Studio is stopped' })).toHaveCount(0);
  });
}
