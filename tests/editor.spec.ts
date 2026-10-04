import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import type { LayoutDocument } from '../src/domain/layout';

const samplePath = 'public/sample-layout.json';
const card = (page: Page, id = 'cpu') => page.locator(`[data-widget-id="${id}"]`);
const field = (page: Page, label: string) => page.getByRole('textbox', { name: label, exact: true });

async function geometry(page: Page) {
  return page.locator('[data-widget-id]').evaluateAll((cards) => cards.map((card) => {
    const element = card as HTMLElement;
    return { id: element.dataset.widgetId, x: parseInt(element.style.left), y: parseInt(element.style.top), width: parseInt(element.style.width), height: parseInt(element.style.height) };
  }));
}

async function openJson(page: Page, text: string) {
  await page.getByLabel('Open layout file', { exact: true }).setInputFiles({ name: 'layout.json', mimeType: 'application/json', buffer: Buffer.from(text) });
}

async function exportJson(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await downloadPromise;
  return readFile((await download.path())!, 'utf8');
}

async function startDrag(page: Page, target: Locator) {
  const bounds = (await target.boundingBox())!;
  const start = { x: bounds.x + Math.min(20, bounds.width / 2), y: bounds.y + Math.min(20, bounds.height / 2) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return start;
}

test('preview resizing preserves geometry and arrow keys move one document pixel', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(card(page)).toHaveCSS('left', '64px');
  await page.screenshot({ path: 'artifacts/studio-preview.png', fullPage: true });
  await card(page).click();
  await page.keyboard.press('ArrowRight');
  await expect(field(page, 'X position')).toHaveValue('65');
  const before = await geometry(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  expect(await geometry(page)).toEqual(before);
  await page.keyboard.press('ArrowRight');
  await expect(field(page, 'X position')).toHaveValue('66');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(field(page, 'Y position')).toHaveValue('170');
  const desktop = await geometry(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await geometry(page)).toEqual(desktop);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('clicking cards or a resize handle preserves drafts committed on blur', async ({ page }) => {
  await page.goto('/');
  await field(page, 'X position').fill('250');
  await card(page, 'gpu').click();
  await expect(card(page)).toHaveCSS('left', '250px');
  await field(page, 'X position').fill('450');
  await page.getByRole('button', { name: 'Resize GPU load', exact: true }).click();
  await expect(card(page, 'gpu')).toHaveCSS('left', '450px');
  await card(page).click();
  await field(page, 'X position').fill('260');
  await card(page).click();
  await expect(card(page)).toHaveCSS('left', '260px');
  await field(page, 'X position').fill('270');
  const start = await startDrag(page, card(page));
  await page.mouse.move(start.x + 30, start.y + 20);
  await expect(card(page)).not.toHaveCSS('left', '270px');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(card(page)).toHaveCSS('left', '270px');
  await field(page, 'X position').fill('280');
  const exported = JSON.parse(await exportJson(page)) as LayoutDocument;
  expect(exported.widgets[0].x).toBe(280);
});

test('real pointer movement and resizing clamp at edges and Escape restores geometry', async ({ page }) => {
  await page.goto('/');
  const scale = await page.locator('.document-canvas').evaluate((canvas) => canvas.getBoundingClientRect().width / 1280);
  let start = await startDrag(page, card(page));
  await page.mouse.move(start.x + 13 * scale, start.y + 7 * scale, { steps: 5 });
  await page.mouse.up();
  await expect(field(page, 'X position')).toHaveValue('77');
  await expect(field(page, 'Y position')).toHaveValue('167');
  start = await startDrag(page, card(page));
  await page.mouse.move(start.x + 2000, start.y + 2000, { steps: 5 });
  await expect(field(page, 'X position')).toHaveValue('928');
  await expect(field(page, 'Y position')).toHaveValue('576');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(field(page, 'X position')).toHaveValue('77');
  await expect(field(page, 'Y position')).toHaveValue('167');
  start = await startDrag(page, page.getByRole('button', { name: 'Resize CPU load', exact: true }));
  await page.mouse.move(start.x + 2000, start.y + 2000, { steps: 5 });
  await page.mouse.up();
  await expect(field(page, 'Width')).toHaveValue('1203');
  await expect(field(page, 'Height')).toHaveValue('633');
  start = await startDrag(page, page.getByRole('button', { name: 'Resize CPU load', exact: true }));
  await page.mouse.move(start.x - 2000, start.y - 2000, { steps: 5 });
  await page.mouse.up();
  await expect(field(page, 'Width')).toHaveValue('1');
  await expect(field(page, 'Height')).toHaveValue('1');
});

test('invalid numeric edits and imports preserve the current document', async ({ page }) => {
  await page.goto('/');
  const before = await geometry(page);
  for (const [input, message] of [['1.5', 'Enter a whole number.'], ['9999', 'Use 0 to 928 px.']]) {
    await field(page, 'X position').fill(input);
    await field(page, 'X position').press('Enter');
    await expect(page.locator('#error-x')).toHaveText(message);
    expect(await geometry(page)).toEqual(before);
  }
  await field(page, 'X position').press('Escape');
  await openJson(page, '{"version":2}');
  await expect(page.getByRole('alert')).toContainText('unsupported layout version');
  expect(await geometry(page)).toEqual(before);
  const duplicate = JSON.parse(await readFile(samplePath, 'utf8')) as LayoutDocument;
  duplicate.widgets[1].id = duplicate.widgets[0].id;
  await openJson(page, JSON.stringify(duplicate));
  await expect(page.getByRole('alert')).toContainText('duplicate widget ID');
  expect(await geometry(page)).toEqual(before);
});

test('offline export and confirmed reopen preserve geometry, settings, and palette', async ({ page, context }) => {
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:4175/')) externalRequests.push(request.url()); });
  await page.goto('/');
  await context.setOffline(true);
  const sample = JSON.parse(await readFile(samplePath, 'utf8')) as LayoutDocument;
  await page.getByLabel('Import palette file', { exact: true }).setInputFiles({
    name: 'scheme.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ name: 'Test scheme', colours: {
      background: '0a0f0f', surfaceContainer: '131b1b', surfaceContainerHigh: '192121', onSurface: 'dce8e7',
      onSurfaceVariant: 'a2adad', primary: 'aa88bb', secondary: 'b0cccc', outlineVariant: '3f4a4a',
    } })),
  });
  await expect(page.getByRole('status')).toContainText('Imported Test scheme');
  await field(page, 'X position').fill('200');
  await field(page, 'X position').press('Enter');
  const first = await exportJson(page);
  const saved = JSON.parse(first) as LayoutDocument;
  expect(saved.widgets[0].x).toBe(200);
  expect(saved.widgets.map((widget) => widget.settings)).toEqual(sample.widgets.map((widget) => widget.settings));
  expect(saved.palette.primary).toBe('#aa88bb');
  await expect(page.getByTestId('document-status')).toHaveText('Export requested');
  await field(page, 'X position').fill('300');
  await field(page, 'X position').press('Enter');
  await openJson(page, first);
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(field(page, 'X position')).toHaveValue('300');
  await openJson(page, first);
  await page.getByRole('button', { name: 'Open and discard changes', exact: true }).click();
  await expect(field(page, 'X position')).toHaveValue('200');
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  expect(await exportJson(page)).toBe(first);
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
});
