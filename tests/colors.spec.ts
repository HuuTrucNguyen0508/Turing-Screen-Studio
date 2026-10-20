import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { chooseMenu, exportJson } from './menus';
import type { Page } from '@playwright/test';
import { createSampleLayout, validateLayout } from '../src/domain/layout';
import type { LayoutDocument } from '../src/domain/layout';

test.use({ storageState: { cookies: [], origins: [] } });
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'Offline colors test' } }));
  await page.goto('/');
});
async function exported(page: Page) {
  const request = page.waitForEvent('download');
  await exportJson(page);
  return validateLayout(JSON.parse(await readFile((await (await request).path())!, 'utf8')));
}
async function openColors(page: Page) {
  await chooseMenu(page, 'Settings', 'Colors');
  return page.getByRole('dialog', { name: 'Colors', exact: true });
}
async function setHex(page: Page, label: string, color: string) {
  const input = page.getByRole('textbox', { name: `${label} hex`, exact: true });
  await input.fill(color); await input.press('Enter');
}
async function openLayout(page: Page, document: LayoutDocument) {
  await page.getByLabel('Open layout file', { exact: true }).setInputFiles({ name: 'colors.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  await expect(page.getByLabel('Layout name', { exact: true })).toHaveValue(document.name);
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
}

test('Studio appearance persists independently of layout colors and history', async ({ page }) => {
  const before = await exported(page);
  const dialog = await openColors(page);
  await dialog.getByRole('button', { name: 'Use Paper for Studio', exact: true }).click();
  await expect(page.locator('.studio')).toHaveCSS('background-color', 'rgb(243, 245, 247)');
  await expect(page.getByTestId('document-canvas')).toHaveCSS('background-color', 'rgb(10, 15, 15)');
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  expect(await exported(page)).toEqual(before);
  await page.reload();
  await expect(page.locator('.studio')).toHaveCSS('background-color', 'rgb(243, 245, 247)');
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light');
});

test('manual dashboard colors support undo and reject invalid hex while Studio stays independent', async ({ page }) => {
  const before = await exported(page);
  const dialog = await openColors(page);
  await dialog.getByRole('button', { name: 'Use Midnight for Studio', exact: true }).click();
  await dialog.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await setHex(page, 'Dashboard background', '#123456');
  await expect(page.getByTestId('document-canvas')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  await expect(page.locator('.studio')).toHaveCSS('background-color', 'rgb(16, 23, 38)');
  const input = dialog.getByRole('textbox', { name: 'Dashboard text hex', exact: true });
  await input.fill('#abc'); await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await input.press('Escape'); await expect(input).toHaveValue(before.palette.text);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const after = await exported(page);
  expect(after.palette.background).toBe('#123456'); expect(after.paletteMode).toBe('saved');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await exported(page)).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await exported(page)).palette.background).toBe('#123456');
});

test('widget colors change only that card and individual resets restore inheritance', async ({ page }) => {
  const colors = page.locator('.widget-colors'); await colors.locator('summary').click();
  await setHex(page, 'Card background', '#334455'); await setHex(page, 'Value and chart', '#77aabb');
  await expect(page.locator('[data-widget-id="cpu"]')).toHaveCSS('background-color', 'rgb(51, 68, 85)');
  await expect(page.locator('[data-widget-id="gpu"]')).toHaveCSS('background-color', 'rgb(19, 27, 27)');
  await expect(page.locator('[data-widget-id="cpu"] .metric-value')).toHaveCSS('color', 'rgb(119, 170, 187)');
  expect((await exported(page)).widgets[0].colors).toEqual({ surface: '#334455', primary: '#77aabb' });
  await colors.getByRole('button', { name: 'Reset Card background color', exact: true }).click();
  expect((await exported(page)).widgets[0].colors).toEqual({ primary: '#77aabb' });
  await colors.getByRole('button', { name: 'Reset widget colors', exact: true }).click();
  expect((await exported(page)).widgets[0].colors).toBeUndefined();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exported(page)).widgets[0].colors).toEqual({ primary: '#77aabb' });
});

test('every widget type retains its overrides through export, reopen and custom widget copies', async ({ page }) => {
  const document = createSampleLayout(); document.chrome = 'none';
  const geometry = { x: 64, y: 64, width: 320, height: 200 };
  document.widgets = [
    document.widgets[0], document.widgets.find(widget => widget.type === 'weather')!,
    { ...geometry, id: 'clock', type: 'clock', settings: { label: 'Clock', time: '14:32', date: 'Tuesday', format: '24h', showDate: true } },
    { ...geometry, id: 'text', type: 'text', settings: { label: 'Note', text: 'A custom color' } },
    { ...geometry, id: 'gauge', type: 'gauge', settings: { label: 'Gauge', value: 24, min: 0, max: 100, unit: '%', detail: 'Sample', style: 'ring' } },
    { ...geometry, id: 'storage', type: 'storage', settings: { label: 'Storage', style: 'bars' } },
    { ...geometry, id: 'image', type: 'image', settings: { label: 'Image', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4nGP8ZSPXwEABYKJE86gBEMDEQCFgGjWAYTQMGCgPAwCu7QH0ZVvN7AAAAABJRU5ErkJggg==', fit: 'contain', opacity: 100 } },
  ].map((widget, index) => ({ ...widget, x: index % 3 * 400 + 24, y: Math.floor(index / 3) * 250 + 24, width: 320, height: 200, colors: { surface: '#223344', text: '#ccddee', primary: '#88bbcc', outline: '#667788' } })) as LayoutDocument['widgets'];
  await openLayout(page, document);
  for (const widget of document.widgets) {
    await expect(page.locator(`[data-widget-id="${widget.id}"]`)).toHaveCSS('background-color', 'rgb(34, 51, 68)');
    expect(await page.locator(`[data-widget-id="${widget.id}"]`).evaluate(element => getComputedStyle(element).getPropertyValue('--primary').trim())).toBe('#88bbcc');
  }
  const after = await exported(page); expect(after).toEqual(validateLayout(document));
  await openLayout(page, after);
  await page.getByRole('button', { name: 'Save as custom widget…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Custom widget name', exact: true }).fill('Colored CPU');
  await page.getByRole('button', { name: 'Save widget', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage).find(([key]) => key.includes('custom-widgets'))?.[1])).toContain('#88bbcc');
});

test('clock elements accept exact colors including the time suffix and retain them in JSON', async ({ page }) => {
  const document = createSampleLayout(); document.widgets = [{ id: 'clock', type: 'clock', x: 160, y: 160, width: 500, height: 280, settings: { label: 'Clock', time: '14:32', date: 'Tuesday', format: '12h', showDate: true } }];
  await openLayout(page, document);
  const design = page.locator('.design-section'); await design.locator('summary').click();
  await design.getByRole('button', { name: /^Time/ }).click();
  await setHex(page, 'Time custom color', '#d56789');
  await expect(page.locator('[data-widget-id="clock"] [data-element="time"]')).toHaveAttribute('fill', '#d56789');
  await expect(page.locator('[data-widget-id="clock"] [data-element="time"] tspan').last()).toHaveAttribute('fill', '#d56789');
  expect((await exported(page)).widgets[0].design?.elements?.time?.color).toBe('#d56789');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-widget-id="clock"] [data-element="time"]')).toHaveAttribute('fill', 'var(--primary)');
});

test('inherited colors can be pinned and clock indicators use the effective widget palette', async ({ page }) => {
  const document = createSampleLayout();
  document.widgets = [{ id: 'clock', type: 'clock', x: 160, y: 160, width: 500, height: 280, colors: { primary: '#778899' }, settings: { label: 'Clock', time: '14:32', date: 'Tuesday', format: '12h', showDate: true } }];
  await openLayout(page, document);
  const dialog = await openColors(page);
  await dialog.getByRole('button', { name: 'Use Paper for Studio', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const colors = page.locator('.widget-colors'); await colors.locator('summary').click();
  const text = colors.getByRole('textbox', { name: 'Text hex', exact: true });
  await text.focus(); await text.blur();
  expect((await exported(page)).widgets[0].colors).toEqual({ primary: '#778899' });
  await text.press('Enter');
  expect((await exported(page)).widgets[0].colors?.text).toBe(document.palette.text);
  const design = page.locator('.design-section'); await design.locator('summary').click();
  const time = design.getByRole('button', { name: /^Time/ });
  await expect(time.locator('.design-dot')).toHaveCSS('background-color', 'rgb(119, 136, 153)');
  await time.click();
  await expect(design.locator('.design-swatch').filter({ has: page.getByRole('radio', { name: 'Primary', exact: true }) }).locator('span')).toHaveCSS('background-color', 'rgb(119, 136, 153)');
  await design.getByRole('textbox', { name: 'Time custom color hex', exact: true }).press('Enter');
  await expect(page.locator('[data-widget-id="clock"] [data-element="time"] tspan').last()).toHaveAttribute('fill', '#778899');
  expect((await exported(page)).widgets[0].design?.elements?.time?.color).toBe('#778899');
  const dashboard = await openColors(page); await dashboard.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await setHex(page, 'Dashboard text', '#112233');
  await dashboard.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(text).toHaveValue(document.palette.text);
});

test('phone color controls fit the viewport and expose touch-sized pickers', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const dialog = await openColors(page);
  await dialog.getByRole('button', { name: 'Use Paper for Studio', exact: true }).click();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  expect(bounds.height).toBeLessThanOrEqual(780);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const input of await dialog.locator('input[type="color"]').all()) {
    const box = (await input.boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
  }
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

test('editing a live dashboard snapshots its palette while Studio can keep following the desktop', async ({ page }) => {
  const document = createSampleLayout(); document.paletteMode = 'live'; document.widgets[0].colors = { primary: '#ccbbaa' };
  let desktop = { ...document.palette, name: 'Desktop', background: '#556677', primary: '#112233' };
  let saves = 0;
  await page.route('**/api/layout', route => {
    if (route.request().method() !== 'GET') saves++;
    return route.fulfill({ json: { document, revision: 'colors-first' } });
  });
  await page.route('**/api/status', route => route.fulfill({ json: { runtimeRunning: false, connected: false, requestedRevision: 'colors-first' } }));
  await page.route('**/api/palette', route => route.fulfill({ json: { palette: desktop } }));
  await page.reload();
  await expect(page.getByTestId('document-canvas')).toHaveCSS('background-color', 'rgb(85, 102, 119)');
  const dialog = await openColors(page);
  await dialog.getByLabel('Studio color source', { exact: true }).selectOption('desktop');
  await dialog.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await setHex(page, 'Dashboard primary accent', '#abcdef');
  desktop = { ...desktop, background: '#334466' };
  await expect(page.locator('.studio')).toHaveCSS('background-color', 'rgb(51, 68, 102)');
  await expect(page.getByTestId('document-canvas')).toHaveCSS('background-color', 'rgb(85, 102, 119)');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const after = await exported(page);
  expect(after.palette).toMatchObject({ background: '#556677', primary: '#abcdef' });
  expect(after.paletteMode).toBe('saved'); expect(after.widgets[0].colors).toEqual({ primary: '#ccbbaa' });
  expect(saves).toBe(0);
});
