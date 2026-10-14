import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createSampleLayout, validateLayout } from '../src/domain/layout';

// Exercise first-run behavior independently of the expanded legacy editor fixture.
test.use({ storageState: { cookies: [], origins: [] } });
async function exported(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  return validateLayout(JSON.parse(await readFile((await (await pending).path())!, 'utf8')));
}
test('first run opens a large canvas and reveals optional panels without editing the layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/');
  const viewport = page.getByLabel('Canvas viewport', { exact: true });
  await expect(page.getByRole('button', { name: 'Widgets', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('complementary', { name: 'Widgets', includeHidden: true })).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Inspector', includeHidden: true })).toBeHidden();
  await expect(page.getByRole('group', { name: 'Preview data', includeHidden: true })).toBeHidden();
  const full = (await viewport.boundingBox())!;
  expect(full.width).toBeGreaterThan(1300); expect(full.height).toBeGreaterThan(470);
  await page.getByRole('button', { name: 'Widgets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Widgets', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('complementary', { name: 'Widgets' })).toBeVisible();
  expect((await viewport.boundingBox())!.width).toBeLessThan(full.width);
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  expect((await page.getByRole('complementary', { name: 'Inspector' }).boundingBox())!.width).toBeGreaterThan(300);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Preview data' })).toBeVisible();
  await page.getByRole('button', { name: 'Close Widgets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Widgets', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Close Inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect.poll(async () => Math.round((await viewport.boundingBox())!.width)).toBe(Math.round(full.width));
  expect(await exported(page)).toEqual(createSampleLayout());
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
test('hidden inspector retains invalid field text, selection and committed edits, and panel choices survive reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('group', { name: 'CPU load card' }).press('ArrowRight');
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await expect(page.getByLabel('X position')).toHaveValue('65');
  await page.getByLabel('X position').fill('1.5');
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await expect(page.getByLabel('X position')).toHaveValue('1.5');
  await expect(page.getByLabel('X position')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('X position').press('Escape');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspector', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('X position')).toHaveValue('65');
  await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Widgets', exact: true })).toHaveAttribute('aria-pressed', 'false');
});
test('adding and importing stay available with panels hidden, and resizing preserves exact nudges', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
  await library.getByLabel('Search widgets', { exact: true }).fill('Clock centered');
  await library.getByRole('button', { name: /Add Clock.*Centered|Add Centered clock/i }).click();
  const card = page.locator('[data-widget-id="clock-centered"]');
  await card.press('Enter'); await card.press('ArrowRight');
  await page.getByRole('button', { name: 'Widgets', exact: true }).click();
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await card.press('ArrowRight');
  const layout = await exported(page);
  expect(layout.widgets.find((widget) => widget.id === 'clock-centered')?.design?.elements?.time?.dx).toBe(2);
  await page.getByRole('button', { name: 'Close Widgets', exact: true }).click();
  await page.getByRole('button', { name: 'Import…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Import', exact: true })).toBeVisible();
});
test('phone panels open into view, close back to their button and fit without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 }); await page.goto('/');
  expect((await page.getByLabel('Canvas viewport', { exact: true }).boundingBox())!.height).toBeGreaterThan(200);
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Inspector' });
  await expect(pane).toBeFocused();
  const bounds = (await pane.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(-1); expect(bounds.y).toBeLessThan(200);
  await pane.getByRole('button', { name: 'Close Inspector', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspector', exact: true })).toBeFocused();
  const button = (await page.getByRole('button', { name: 'Inspector', exact: true }).boundingBox())!;
  expect(button.y).toBeGreaterThanOrEqual(0); expect(button.y + button.height).toBeLessThanOrEqual(780);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('removing a card with Widgets hidden focuses the next canvas card for continued keyboard editing', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  const next = page.getByRole('group', { name: 'GPU load card' });
  await expect(next).toBeFocused();
  await next.press('ArrowRight');
  expect((await exported(page)).widgets.find((widget) => widget.id === 'gpu')?.x).toBe(createSampleLayout().widgets.find((widget) => widget.id === 'gpu')!.x + 1);
});
test('every panel fits common desktop windows without page scrolling', async ({ page }) => {
  for (const [width, height, canvasWidth] of [[1280, 800, 540], [1600, 1000, 820]]) {
    await page.setViewportSize({ width, height }); await page.goto('/');
    for (const name of ['Widgets', 'Inspector', 'Tools']) {
      const toggle = page.getByRole('button', { name, exact: true });
      if (await toggle.getAttribute('aria-pressed') === 'false') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    }
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(height);
    const movement = (await page.getByRole('group', { name: 'Precise movement' }).boundingBox())!;
    expect(movement.y + movement.height).toBeLessThanOrEqual(height);
    expect((await page.getByTestId('document-canvas').boundingBox())!.width).toBeGreaterThan(canvasWidth);
  }
});
