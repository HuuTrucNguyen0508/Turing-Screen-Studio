import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createSampleLayout, validateLayout } from '../src/domain/layout';

async function exported(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  return validateLayout(JSON.parse(await readFile((await (await pending).path())!, 'utf8')));
}

test('first run docks Layers and Inspector beside the canvas and folds them without editing the layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/');
  const viewport = page.getByLabel('Canvas viewport', { exact: true });
  await expect(page.getByRole('complementary', { name: 'Layers' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Preview data' })).toBeVisible();
  const docked = (await viewport.boundingBox())!;
  expect(docked.width).toBeGreaterThan(820); expect(docked.height).toBeGreaterThan(600);
  await page.getByRole('button', { name: 'Hide Layers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show Layers', exact: true })).toBeFocused();
  await expect(page.getByRole('complementary', { name: 'Layers', includeHidden: true })).toBeHidden();
  await page.getByRole('button', { name: 'Hide Inspector', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show Inspector', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await viewport.boundingBox())!.width).toBeGreaterThan(1300);
  await page.getByRole('button', { name: 'Show Layers', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Layers' })).toBeFocused();
  await page.getByRole('button', { name: 'Show Inspector', exact: true }).click();
  await expect.poll(async () => Math.round((await viewport.boundingBox())!.width)).toBe(Math.round(docked.width));
  expect(await exported(page)).toEqual(createSampleLayout());
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('a folded inspector retains invalid field text, selection and committed edits, and panel choices survive reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('group', { name: 'CPU load card' }).press('ArrowRight');
  await expect(page.getByLabel('X position')).toHaveValue('65');
  await page.getByLabel('X position').fill('1.5');
  await page.getByRole('button', { name: 'Hide Inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Show Inspector', exact: true }).click();
  await expect(page.getByLabel('X position')).toHaveValue('1.5');
  await expect(page.getByLabel('X position')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('X position').press('Escape');
  await page.getByRole('button', { name: 'Hide Layers', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(page.getByLabel('X position')).toHaveValue('65');
  await expect(page.getByRole('button', { name: 'Show Layers', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide Inspector', exact: true })).toBeVisible();
});

test('adding and importing stay available with panels folded, and resizing preserves exact nudges', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Hide Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Hide Inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
  await library.getByLabel('Search widgets', { exact: true }).fill('Clock centered');
  await library.getByRole('button', { name: /Add Clock.*Centered|Add Centered clock/i }).click();
  const card = page.locator('[data-widget-id="clock-centered"]');
  await card.press('Enter'); await card.press('ArrowRight');
  await page.getByRole('button', { name: 'Show Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Show Inspector', exact: true }).click();
  await card.press('ArrowRight');
  const layout = await exported(page);
  expect(layout.widgets.find((widget) => widget.id === 'clock-centered')?.design?.elements?.time?.dx).toBe(2);
  await page.getByRole('button', { name: 'Import…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Import', exact: true })).toBeVisible();
});

test('phone panels follow the canvas, fold back to their button and fit without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 }); await page.goto('/');
  const viewport = (await page.getByLabel('Canvas viewport', { exact: true }).boundingBox())!;
  expect(viewport.height).toBeGreaterThan(200);
  const pane = page.getByRole('complementary', { name: 'Inspector' });
  expect((await pane.boundingBox())!.y).toBeGreaterThan(viewport.y + viewport.height);
  await page.getByRole('group', { name: 'Selection actions', exact: true }).getByRole('button', { name: 'Edit selection details' }).click();
  await expect(pane).toBeFocused();
  const bounds = (await pane.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(-1); expect(bounds.y).toBeLessThan(200);
  await pane.getByRole('button', { name: 'Hide Inspector', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show Inspector', exact: true })).toBeFocused();
  const button = (await page.getByRole('button', { name: 'Show Inspector', exact: true }).boundingBox())!;
  expect(button.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('deleting a card with Layers folded focuses the next canvas card for continued keyboard editing', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Hide Layers', exact: true }).click();
  await page.getByRole('group', { name: 'CPU load card' }).click({ position: { x: 20, y: 20 } });
  await page.getByRole('button', { name: 'Delete selected widget', exact: true }).click();
  const next = page.getByRole('group', { name: 'GPU load card' });
  await expect(next).toBeFocused();
  await next.press('ArrowRight');
  expect((await exported(page)).widgets.find((widget) => widget.id === 'gpu')?.x).toBe(createSampleLayout().widgets.find((widget) => widget.id === 'gpu')!.x + 1);
});

test('header menus open from the keyboard and return focus when closed', async ({ page }) => {
  await page.goto('/');
  const layout = page.getByRole('button', { name: 'Layout', exact: true });
  await layout.focus(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Create layout', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Open layout', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(layout).toBeFocused();
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Keyboard shortcuts' })).toContainText('Paste the newest copy');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts', exact: true })).toBeFocused();
});

for (const viewport of [{ width: 360, height: 740 }, { width: 1280, height: 800 }, { width: 1600, height: 1000 }]) {
  test(`expanded Data sources keeps stage controls in bounds at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const summary = page.getByText('Data sources', { exact: true });
    await summary.click();
    const stage = (await page.locator('.preview-panel').boundingBox())!;
    for (const control of [page.getByLabel('Canvas zoom', { exact: true }), page.getByRole('button', { name: 'Keyboard shortcuts', exact: true })]) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(stage.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(stage.x + stage.width);
    }
    const note = page.getByText('Connect to the local Studio server to inspect runtime readings.', { exact: true });
    const bounds = (await note.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(stage.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(stage.x + stage.width);
    await expect(note).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/ui-simplify/fix-sources-${viewport.width}x${viewport.height}.png` });
  });
}
