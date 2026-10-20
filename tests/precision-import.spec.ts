import { expect, test } from '@playwright/test';
import { exportJson } from './menus';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createSampleLayout, validateLayout } from '../src/domain/layout';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4nGP8ZSPXwEABYKJE86gBEMDEQCFgGjWAYTQMGCgPAwCu7QH0ZVvN7AAAAABJRU5ErkJggg==', 'base64');
async function exported(page: Page) {
  const request = page.waitForEvent('download');
  await exportJson(page);
  return validateLayout(JSON.parse(await readFile((await (await request).path())!, 'utf8')));
}
async function addClock(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
  await library.getByLabel('Search widgets', { exact: true }).fill('Clock centered');
  await library.getByRole('button', { name: /Add Clock.*Centered|Add Centered clock/i }).click();
  return page.locator('[data-widget-id="clock-centered"]');
}
test('element targets nudge precise offsets at different zooms, undo and return to card movement', async ({ page }) => {
  const card = await addClock(page);
  const x = Number(await page.getByLabel('X position').inputValue());
  await card.press('Enter');
  await expect(page.getByRole('group', { name: 'Arrows move' }).getByRole('button', { name: 'Time', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await card.press('ArrowRight'); await card.press('Shift+ArrowDown');
  await expect(page.getByLabel('X position')).toHaveValue(String(x));
  await expect(card.locator('.resize-handle')).toHaveCount(0);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await card.press('ArrowRight');
  let document = await exported(page);
  expect(document.widgets.find((widget) => widget.id === 'clock-centered')?.design?.elements?.time).toMatchObject({ dx: 2, dy: 10 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  document = await exported(page);
  expect(document.widgets.find((widget) => widget.id === 'clock-centered')?.design?.elements?.time).toMatchObject({ dx: 1, dy: 10 });
  await card.press('Escape'); await card.press('ArrowRight');
  await expect(page.getByLabel('X position')).toHaveValue(String(x + 1));
  await expect(card.locator('[data-resize-handle="se"]')).toHaveCount(1);
});
test('target buttons focus the card and geometry fields nudge their valid draft without moving another axis', async ({ page }) => {
  const card = await addClock(page);
  await page.getByRole('group', { name: 'Arrows move' }).getByRole('button', { name: 'Date', exact: true }).click();
  await expect(card).toBeFocused(); await page.keyboard.press('ArrowLeft');
  await page.getByLabel('X position').fill('100'); await page.getByLabel('X position').press('ArrowUp');
  await expect(page.getByLabel('X position')).toHaveValue('101');
  const doc = await exported(page);
  expect(doc.widgets.find((widget) => widget.id === 'clock-centered')).toMatchObject({ x: 101, design: { elements: { date: { dx: -1, dy: 0 } } } });
  await page.getByRole('group', { name: 'Arrows move' }).getByRole('button', { name: 'Time', exact: true }).click();
  await page.locator('[data-widget-row="cpu"]').click({ modifiers: ['Shift'] });
  await expect(page.getByRole('group', { name: 'Arrows move' }).getByRole('button', { name: 'Time', exact: true })).toHaveCount(0);
});
test('reviewed layout widgets add in one undo entry and preserve the draft and palette', async ({ page }) => {
  await page.goto('/');
  const original = createSampleLayout();
  await page.getByRole('button', { name: 'Import…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import', exact: true });
  await dialog.getByLabel('Import material files').setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(original)) });
  await expect(dialog.getByRole('button', { name: 'Add 4 to layout' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Add 4 to layout' }).click();
  const doc = await exported(page);
  expect(doc.widgets).toHaveLength(8); expect(new Set(doc.widgets.map((widget) => widget.id)).size).toBe(8);
  expect(doc.palette).toEqual(original.palette); expect(doc.widgets.slice(0, 4)).toEqual(original.widgets);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exported(page)).widgets).toEqual(original.widgets);
});
test('images embed, fill the canvas behind widgets, export and reopen with opacity intact', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Import…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import', exact: true });
  await dialog.getByLabel('Import material files').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: png });
  await dialog.getByLabel('Use red.png as background').check();
  await dialog.getByRole('button', { name: 'Add 1 to layout' }).click();
  await page.getByLabel('Opacity (%)').fill('40'); await page.getByLabel('Opacity (%)').press('Enter');
  const doc = await exported(page);
  expect(doc.widgets[0]).toMatchObject({ type: 'image', x: 0, y: 0, width: 1280, height: 800, settings: { fit: 'cover', opacity: 40 } });
  expect(doc.widgets[0].type === 'image' && doc.widgets[0].settings.data.startsWith('data:image/png;base64,')).toBe(true);
  await page.reload(); await page.getByRole('dialog', { name: 'Recover a draft' }).getByRole('button', { name: 'Restore draft', exact: true }).click();
  expect((await exported(page)).widgets).toEqual(doc.widgets);
});
test('Turing themes convert to review drafts and foreign panels explain compatibility without replacing work', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Import…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import', exact: true });
  const yaml = 'display:\n  DISPLAY_SIZE: \'3.5"\'\n  DISPLAY_ORIENTATION: landscape\nstatic_text:\n  Note:\n    TEXT: Imported note\n    X: 20\n    Y: 20\n    WIDTH: 200\n    HEIGHT: 100\n    FONT_SIZE: 18\n';
  await dialog.getByLabel('Import material files').setInputFiles({ name: 'theme.yaml', mimeType: 'application/yaml', buffer: Buffer.from(yaml) });
  await expect(dialog.getByRole('button', { name: 'Add 1 to layout' })).toBeVisible();
  await expect(dialog.getByText(/source text typography is replaced/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Add 1 to layout' }).click();
  await page.getByRole('button', { name: 'Import…', exact: true }).click();
  await dialog.getByLabel('Import material files').setInputFiles({ name: 'theme.sensorpanel', mimeType: 'application/octet-stream', buffer: Buffer.from('AIDA64\0binary') });
  await expect(dialog.getByRole('alert')).toContainText('cannot be converted');
  await dialog.getByRole('button', { name: 'Close import' }).click();
  expect((await exported(page)).widgets).toHaveLength(5);
});
test('canvas file drops open review and mobile import stays within the viewport', async ({ page }) => {
  await page.goto('/');
  const transfer = await page.evaluateHandle((text) => { const value = new DataTransfer(); value.items.add(new File([text], 'cards.json', { type: 'application/json' })); return value; }, JSON.stringify(createSampleLayout()));
  await page.getByLabel('Canvas viewport', { exact: true }).dispatchEvent('drop', { dataTransfer: transfer });
  const dialog = page.getByRole('dialog', { name: 'Import', exact: true });
  await expect(dialog.getByRole('button', { name: 'Add 4 to layout' })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate((element) => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1; })).toBe(true);
});

async function machineStore(page: Page) {
  await page.route('**/api/layout', (route) => route.fulfill({ json: { document: createSampleLayout(), revision: 'panel' } }));
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Local preview' } }));
}
const note = (label: string) => ({ type: 'text', width: 200, height: 100, settings: { label, text: label } });
test('an import reviewed during storage loading saves against the settled revision', async ({ page }) => {
  await machineStore(page);
  let release!: () => void, gets = 0, writes = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/widgets', async (route) => {
    if (route.request().method() === 'POST') {
      writes++; expect(route.request().headers()['if-match']).toBe('widgets-1');
      return route.fulfill({ json: { ...route.request().postDataJSON(), revision: 'widgets-2' } });
    }
    gets++; await gate; await route.fulfill({ json: { version: 1, widgets: [], revision: 'widgets-1' } });
  });
  await page.goto('/'); await expect.poll(() => gets).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Import…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import', exact: true });
  await dialog.getByLabel('Import material files').setInputFiles({ name: 'note.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(note('Loading note'))) });
  await expect(dialog.getByRole('button', { name: 'Add 1 to layout' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save 1 custom widgets' })).toBeDisabled();
  release(); await expect(dialog.getByRole('button', { name: 'Save 1 custom widgets' })).toBeEnabled();
  await expect(dialog.getByText(/Reusable copies:/)).toContainText('Saved on this machine');
  await dialog.getByRole('button', { name: 'Save 1 custom widgets' }).click();
  await expect(dialog.getByText(/Saved 1 custom widgets/)).toBeVisible(); expect(writes).toBe(1);
});
test('a previous save completion cannot dismiss a newly dropped import review', async ({ page }) => {
  await machineStore(page);
  let release!: () => void, writes = 0;
  let stored: { widgets: { widget: { settings: { label: string } } }[] } = { widgets: [] };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/widgets', async (route) => {
    if (route.request().method() === 'POST') {
      writes++; await gate;
      expect(route.request().headers()['if-match']).toBe(`widgets-${writes}`);
      stored = route.request().postDataJSON();
      return route.fulfill({ json: { ...stored, revision: `widgets-${writes + 1}` } });
    }
    await route.fulfill({ json: { version: 1, widgets: [], revision: 'widgets-1' } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Import…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import', exact: true });
  await dialog.getByLabel('Import material files').setInputFiles({ name: 'first.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(note('First note'))) });
  await expect(dialog.getByRole('button', { name: 'Save 1 custom widgets' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Save 1 custom widgets' }).click(); await expect.poll(() => writes).toBe(1);
  const transfer = await page.evaluateHandle((text) => { const value = new DataTransfer(); value.items.add(new File([text], 'second.json', { type: 'application/json' })); return value; }, JSON.stringify(note('Second note')));
  await dialog.locator('.material-drop').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(dialog.getByRole('heading', { name: 'second.json' })).toBeVisible();
  release(); await expect(dialog.getByRole('button', { name: 'Save 1 custom widgets' })).toBeEnabled();
  await expect(dialog.getByRole('heading', { name: 'second.json' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save 1 custom widgets' }).click();
  await expect(dialog.getByText(/Saved 1 custom widgets/)).toBeVisible();
  expect(writes).toBe(2); expect(stored.widgets.map((entry) => entry.widget.settings.label)).toEqual(['First note', 'Second note']);
});
test('malformed embedded PNG pixels fail both reviewed and direct layout imports without changing the draft', async ({ page }) => {
  const invalid = { ...createSampleLayout(), widgets: [{ id: 'bad-image', type: 'image', x: 0, y: 0, width: 100, height: 100, settings: { label: 'Bad pixels', fit: 'contain', opacity: 100, data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVRub3QgYSBkZWZsYXRlIHN0cmVhbdCi+LkAAAAASUVORK5CYII=' } }] };
  await page.goto('/'); await page.getByRole('group', { name: 'CPU load card' }).press('ArrowRight');
  const original = await exported(page);
  const file = { name: 'invalid-pixels.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) };
  await page.getByRole('button', { name: 'Import…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import', exact: true });
  await dialog.getByLabel('Import material files').setInputFiles(file);
  await expect(dialog.getByRole('alert')).toContainText('could not be decoded');
  await expect(dialog.getByRole('button', { name: /Add \d+ to layout/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close import' }).click();
  await page.getByLabel('Open layout file').setInputFiles(file);
  await expect(page.getByRole('alert')).toContainText('could not be decoded');
  expect(await exported(page)).toEqual(original);
});
test('standalone images above the reusable-pack limit can be imported as draft widgets', async ({ page }) => {
  await page.goto('/');
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 384; canvas.height = 192;
    const context = canvas.getContext('2d')!, pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 27;
    for (let i = 0; i < pixels.data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels.data[i + channel] = seed >>> 24; }
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0); return canvas.toDataURL('image/png');
  });
  expect(data.length).toBeGreaterThan(256 * 1024); expect(data.length).toBeLessThan(512 * 1024);
  await page.getByRole('button', { name: 'Import…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import', exact: true });
  await dialog.getByLabel('Import material files').setInputFiles({ name: 'large-image.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ type: 'image', width: 384, height: 192, settings: { label: 'Large portable image', data, fit: 'contain', opacity: 100 } })) });
  await dialog.getByRole('button', { name: 'Save 1 custom widgets' }).click();
  await expect(dialog.getByRole('alert')).toContainText(/256/);
  await dialog.getByRole('button', { name: 'Add 1 to layout' }).click();
  let previous = await exported(page);
  expect(previous.widgets.at(-1)?.settings).toMatchObject({ data });
  // A batch that exceeds the whole-layout cap must leave every earlier card intact.
  await page.getByRole('button', { name: 'Import…', exact: true }).click();
  const transfer = await page.evaluateHandle((data) => { const value = new DataTransfer(); for (let i = 0; i < 4; i++) value.items.add(new File([Uint8Array.from(atob(data.split(',')[1]), (c) => c.charCodeAt(0))], `copy-${i}.png`, {type: 'image/png'})); return value; }, data);
  await dialog.locator('.material-drop').dispatchEvent('drop', { dataTransfer: transfer });
  await dialog.getByRole('button', { name: 'Add 4 to layout' }).click();
  await expect(dialog.getByRole('alert')).toContainText(/1 MiB/);
  await dialog.getByRole('button', { name: 'Close import' }).click();
  expect(await exported(page)).toEqual(previous);
});
