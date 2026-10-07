import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';

async function exported(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}

test('portrait resizing exports integer cards and one Undo restores the complete document', async ({ page }) => {
  await page.goto('/');
  const original = await exported(page);
  await page.getByRole('button', { name: 'Change canvas size' }).click();
  const dialog = page.getByRole('dialog', { name: 'Canvas size', exact: true });
  await dialog.getByRole('combobox').selectOption('320x480');
  await expect(dialog.getByRole('radio', { name: /^Keep positions/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Resize canvas', exact: true }).click();
  await expect(page.getByText('Portrait canvas', { exact: true })).toBeVisible();
  const next = await exported(page);
  expect(next.canvas).toEqual({ width: 320, height: 480 });
  for (const card of next.widgets) {
    expect([card.x, card.y, card.width, card.height].every(Number.isInteger)).toBe(true);
    expect(card.x + card.width).toBeLessThanOrEqual(320);
    expect(card.y + card.height).toBeLessThanOrEqual(480);
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await exported(page)).toEqual(original);
});

test('mobile dialog rejects bad sizes, swaps orientation and cancels without changes', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Change canvas size' }).click();
  const dialog = page.getByRole('dialog', { name: 'Canvas size', exact: true });
  await dialog.getByLabel('Canvas width', { exact: true }).fill('1.5');
  await expect(dialog.getByRole('alert')).toContainText('whole pixel');
  await expect(dialog.getByRole('button', { name: 'Resize canvas', exact: true })).toBeDisabled();
  await dialog.getByRole('combobox').selectOption('480x320');
  await dialog.getByRole('button', { name: 'Swap width and height' }).click();
  await expect(dialog.getByLabel('Canvas width', { exact: true })).toHaveValue('320');
  await expect(dialog.getByLabel('Canvas height', { exact: true })).toHaveValue('480');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/canvas-size-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Change canvas size' })).toContainText('1280 × 800');
});

test('connected custom sizes cannot write the panel or add a draft to its library', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST' && ['/api/layout', '/api/layouts'].includes(path)) writes++;
    return route.fulfill({ json: path === '/api/layout' ? { document: createSampleLayout(), revision: 'a'.repeat(64) }
      : path === '/api/layouts' ? { entries: [], activeId: null, revision: 'b'.repeat(64) }
      : path === '/api/status' ? { runtimeRunning: false, connected: false } : {} });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Change canvas size' }).click();
  const dialog = page.getByRole('dialog', { name: 'Canvas size', exact: true });
  await dialog.getByRole('combobox').selectOption('800x480');
  await dialog.getByRole('button', { name: 'Resize canvas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeDisabled();
  await expect(page.getByText('Panel saves need 1280 × 800. Export JSON to keep this draft.', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add current draft', exact: true })).toBeDisabled();
  expect(writes).toBe(0);
});

test('clear and resize removes cards and Undo restores them', async ({ page }) => {
  await page.goto('/');
  const original = await exported(page);
  await page.getByRole('button', { name: 'Change canvas size' }).click();
  const dialog = page.getByRole('dialog', { name: 'Canvas size', exact: true });
  await dialog.getByRole('radio', { name: 'Start with an empty canvas', exact: true }).check();
  await dialog.getByRole('button', { name: 'Clear and resize', exact: true }).click();
  expect((await exported(page)).widgets).toEqual([]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await exported(page)).toEqual(original);
});
