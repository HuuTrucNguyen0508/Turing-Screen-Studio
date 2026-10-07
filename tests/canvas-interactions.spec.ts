import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSampleLayout, validateLayout } from '../src/domain/layout';
import type { LayoutDocument } from '../src/domain/layout';

test.use({ storageState: { cookies: [], origins: [] } });
const card = (page: Page, id = 'clock') => page.locator(`[data-widget-id="${id}"]`);
function fixture(): LayoutDocument {
  return { ...createSampleLayout(), chrome: 'none', widgets: [
    { id: 'clock', type: 'clock', x: 160, y: 200, width: 380, height: 260, settings: { label: 'Local time', time: '10:24', date: 'Sunday, 4 October', format: '12h', showDate: true } },
    { id: 'other-clock', type: 'clock', x: 650, y: 200, width: 380, height: 260, settings: { label: 'Time elsewhere', time: '14:32', date: 'Sunday, 4 October', format: '24h', showDate: true } },
  ] };
}
async function exported(page: Page) {
  const request = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  return validateLayout(JSON.parse(await readFile((await (await request).path())!, 'utf8')));
}
async function geometry(page: Page, id = 'clock') {
  return card(page, id).evaluate((element) => {
    const style = (element as HTMLElement).style;
    return { x: parseInt(style.left), y: parseInt(style.top), width: parseInt(style.width), height: parseInt(style.height) };
  });
}
async function factor(page: Page) {
  return page.getByTestId('document-canvas').evaluate((element) => element.getBoundingClientRect().width / 1280);
}
async function drag(page: Page, locator: ReturnType<Page['locator']>, dx: number, dy: number, release = true) {
  const box = (await locator.boundingBox())!;
  const scale = await factor(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx * scale, box.y + box.height / 2 + dy * scale, { steps: 4 });
  if (release) await page.mouse.up();
}
async function open(page: Page, layout = fixture()) {
  await page.goto('/');
  await page.getByLabel('Open layout file', { exact: true }).setInputFiles({ name: 'clock.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(layout)) });
  await expect(card(page)).toBeVisible();
  await page.getByRole('checkbox', { name: 'Snapping', exact: true }).uncheck();
}
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Offline test' } }));
});

test('double-click selects exact clock text without edits and preserves pixel nudges and Esc', async ({ page }) => {
  await open(page);
  const before = await geometry(page);
  const time = card(page).locator('[data-element-target="time"]');
  await time.dblclick();
  await expect(time).toHaveAttribute('data-active', 'true');
  await expect(card(page)).toBeFocused();
  await expect(card(page).locator('[data-resize-handle]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
  expect(await geometry(page)).toEqual(before);
  expect((await exported(page)).widgets[0].design?.elements?.time).toMatchObject({ dx: 1, dy: 10 });
  await card(page).press('Escape'); await card(page).press('ArrowRight');
  expect(await geometry(page)).toEqual({ ...before, x: before.x + 1 });
  await expect(card(page).locator('[data-resize-handle]')).toHaveCount(8);
});

test('direct selection works on another card and targets label, time including suffix, and date', async ({ page }) => {
  await open(page);
  for (const id of ['label', 'time', 'date']) {
    const target = card(page, 'other-clock').locator(`[data-element-target="${id}"]`);
    await target.dblclick();
    await expect(target).toHaveAttribute('data-active', 'true');
    await expect(card(page, 'other-clock')).toBeFocused();
    await expect(page.getByRole('group', { name: 'Arrows move' }).getByRole('button', { name: id[0].toUpperCase() + id.slice(1), exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  // The AM suffix belongs to the time hit area too.
  const time = card(page).locator('[data-element-target="time"]');
  const bounds = (await time.boundingBox())!;
  await page.mouse.dblclick(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2);
  await expect(time).toHaveAttribute('data-active', 'true');
});

test('element dragging at zoom commits once, cancels safely, and keeps card geometry', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const before = await geometry(page);
  const date = card(page).locator('[data-element-target="date"]');
  await date.dblclick(); await drag(page, date, 15, -10, false);
  await expect(page.getByTestId('gesture-readout')).toContainText('Date / X offset 15 / Y offset -10');
  await page.mouse.up();
  expect((await exported(page)).widgets[0].design?.elements?.date).toMatchObject({ dx: 15, dy: -10 });
  expect(await geometry(page)).toEqual(before);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await drag(page, date, 20, 12, false); await page.keyboard.press('Escape'); await page.mouse.up();
  expect((await exported(page)).widgets[0].design).toBeUndefined();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
});

test('all resize handles anchor opposite edges and each drag is one undo entry', async ({ page }) => {
  await open(page);
  const before = await geometry(page);
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    await drag(page, card(page).locator(`[data-resize-handle="${handle}"]`), 20, 10, false);
    const west = handle.includes('w'), east = handle.includes('e'), north = handle.includes('n'), south = handle.includes('s');
    const expected = { x: before.x + (west ? 20 : 0), y: before.y + (north ? 10 : 0), width: before.width + (west ? -20 : east ? 20 : 0), height: before.height + (north ? -10 : south ? 10 : 0) };
    expect(await geometry(page)).toEqual(expected);
    await expect(page.getByTestId('gesture-readout')).toContainText(`${expected.width} × ${expected.height} px`);
    await page.mouse.up();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await geometry(page)).toEqual(before);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  }
  const handle = card(page).locator('[data-resize-handle="nw"]');
  await handle.press('Shift+ArrowLeft'); await handle.press('ArrowUp');
  expect(await geometry(page)).toEqual({ x: before.x - 10, y: before.y - 1, width: before.width + 10, height: before.height + 1 });
});

test('context actions duplicate, delete, focus the survivor, and reveal details', async ({ page }) => {
  await open(page);
  const toolbar = page.getByRole('group', { name: 'Selection actions', exact: true });
  await toolbar.getByRole('button', { name: 'Duplicate selected widget' }).click();
  await expect(page.locator('[data-widget-id]')).toHaveCount(3);
  await expect(page.locator('[data-widget-id][data-primary="true"]')).toBeFocused();
  await toolbar.getByRole('button', { name: 'Delete selected widget' }).click();
  await expect(page.locator('[data-widget-id]')).toHaveCount(2);
  await expect(card(page, 'other-clock')).toBeFocused();
  await page.keyboard.press('ArrowRight'); expect((await geometry(page, 'other-clock')).x).toBe(651);
  await toolbar.getByRole('button', { name: 'Edit selection details' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await expect(page.getByLabel('X position', { exact: true })).toHaveValue('651');
});

test('group alignment remains available with tools hidden and preserves selection', async ({ page }) => {
  await open(page);
  await card(page, 'other-clock').click({ modifiers: ['Shift'], position: { x: 20, y: 20 } });
  const toolbar = page.getByRole('group', { name: 'Selection actions', exact: true });
  await toolbar.locator('summary').click();
  await toolbar.getByRole('button', { name: 'Selection align left' }).click();
  expect((await geometry(page, 'other-clock')).x).toBe(160);
  await expect(page.locator('[data-widget-id][data-selected="true"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await geometry(page, 'other-clock')).x).toBe(650);
});

test('phone selection actions dock outside canvas with touch targets and accessible details', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 }); await open(page);
  const toolbar = page.getByRole('group', { name: 'Selection actions', exact: true });
  const viewport = (await page.getByLabel('Canvas viewport', { exact: true }).boundingBox())!;
  const dock = (await toolbar.boundingBox())!;
  expect(dock.y).toBeGreaterThanOrEqual(viewport.y + viewport.height);
  expect(viewport.height).toBeGreaterThan(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await toolbar.getByRole('button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const handle of await card(page).locator('[data-resize-handle]').all()) expect((await handle.boundingBox())!.width).toBeGreaterThanOrEqual(43.9);
  await toolbar.getByRole('button', { name: 'Edit selection details' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeFocused();
  await page.getByRole('button', { name: 'Close Inspector' }).click();
  await page.getByRole('group', { name: 'Arrows move' }).getByRole('button', { name: 'Time', exact: true }).click();
  await page.getByRole('button', { name: 'Nudge right' }).click();
  expect((await exported(page)).widgets[0].design?.elements?.time?.dx).toBe(1);
});

test('alignment menu stays visible at the left canvas boundary and Esc returns focus', async ({ page }) => {
  await open(page);
  await card(page, 'other-clock').click({ modifiers: ['Shift'], position: { x: 20, y: 20 } });
  const viewport = (await page.getByLabel('Canvas viewport', { exact: true }).boundingBox())!;
  await page.keyboard.down('Space');
  await page.mouse.move(viewport.x + 30, viewport.y + 30); await page.mouse.down();
  await page.mouse.move(viewport.x - 470, viewport.y + 30); await page.mouse.up(); await page.keyboard.up('Space');
  const toolbar = page.getByRole('group', { name: 'Selection actions', exact: true });
  await toolbar.locator('summary').click();
  const menu = toolbar.getByRole('group', { name: 'Align selected cards' });
  for (const button of await menu.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(viewport.x); expect(box.x + box.width).toBeLessThanOrEqual(viewport.x + viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(viewport.y); expect(box.y + box.height).toBeLessThanOrEqual(viewport.y + viewport.height);
    expect(await button.evaluate((element) => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
  }
  await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(toolbar.locator('summary')).toBeFocused();
});

test('compact phone cards have one unambiguous handle and precise controls for every edge', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const layout = fixture(); layout.widgets[0].height = 100; await open(page, layout);
  await expect(card(page).locator('[data-resize-handle]')).toHaveCount(1);
  const handle = card(page).locator('[data-resize-handle="se"]'); await handle.scrollIntoViewIfNeeded();
  expect(await handle.evaluate((element) => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element; })).toBe(true);
  await page.getByRole('group', { name: 'Selection actions', exact: true }).getByRole('button', { name: 'Resize', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Resize Local time', exact: true });
  await expect(dialog.getByRole('radio')).toHaveCount(10);
  await dialog.getByRole('radio', { name: 'Top left', exact: true }).check();
  await dialog.getByRole('radio', { name: '10 px', exact: true }).check();
  await dialog.getByRole('button', { name: 'Resize toward left', exact: true }).click();
  await dialog.getByRole('button', { name: 'Resize toward up', exact: true }).click();
  expect(await geometry(page)).toEqual({ x: 150, y: 190, width: 390, height: 110 });
  expect(await dialog.evaluate((element) => { const box = element.getBoundingClientRect(); return box.x >= 0 && box.right <= innerWidth && box.height <= innerHeight && element.scrollWidth <= element.clientWidth; })).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(card(page)).toBeFocused();
  await page.keyboard.press('ArrowRight'); expect((await geometry(page)).x).toBe(151);
});

test('plain clock visible text matches hit targets through the trailing label characters', async ({ page }) => {
  const layout = fixture(); const widget = layout.widgets[0];
  if (widget.type !== 'clock') throw new Error('Clock fixture required');
  widget.settings.label = 'A long local clock label'; await open(page, layout);
  const text = card(page).locator('[data-element="label"]');
  const box = (await text.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width - 2, box.y + box.height / 2);
  await expect(card(page).locator('[data-element-target="label"]')).toHaveAttribute('data-active', 'true');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('keyboard resizing keeps its focused edge when the card becomes compact', async ({ page }) => {
  const layout = fixture(); layout.widgets[0].height = 130; await open(page, layout);
  const handle = card(page).locator('[data-resize-handle="nw"]');
  await handle.press('Shift+ArrowDown'); await handle.press('Shift+ArrowDown');
  await expect(handle).toBeFocused(); await handle.press('ArrowDown');
  expect(await geometry(page)).toEqual({ x: 160, y: 221, width: 380, height: 109 });
  await expect(handle).toBeFocused();
});

test('phone boundary handles keep their whole touch areas usable inside the canvas', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const layout = fixture(); layout.widgets = [{ ...layout.widgets[0], x: 0, y: 0, width: 1280, height: 800 }]; await open(page, layout);
  await card(page).scrollIntoViewIfNeeded();
  for (const handle of await card(page).locator('[data-resize-handle]').all()) {
    expect(await handle.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [[2, 2], [box.width - 2, 2], [2, box.height - 2], [box.width - 2, box.height - 2]].every(([x, y]) => element.contains(document.elementFromPoint(box.x + x, box.y + y)));
    })).toBe(true);
  }
});

test('phone boundary insets switch overlapping handles to compact resize', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const layout = fixture(); layout.widgets = [{ ...layout.widgets[0], x: 0, y: 0, width: 420, height: 420 }];
  await open(page, layout);
  const box = (await card(page).boundingBox())!;
  // This card exceeds the old 96 px threshold, but the boundary insets overlap.
  expect(box.width).toBeGreaterThan(96); expect(box.width).toBeLessThan(140);
  await expect(card(page).locator('[data-resize-handle]')).toHaveCount(1);
  await page.getByRole('group', { name: 'Selection actions', exact: true }).getByRole('button', { name: 'Resize', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Resize Local time', exact: true }).getByRole('radio', { name: 'Top left', exact: true })).toBeVisible();
});
