import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';

const card = (page: Page, id: string) => page.locator(`[data-widget-id="${id}"]`);
const row = (page: Page, id: string) => page.locator(`[data-widget-row="${id}"]`);
const selected = (page: Page) => page.locator('[data-widget-id][data-selected="true"]');
async function geometry(page: Page) {
  return page.locator('[data-widget-id]').evaluateAll((elements) => elements.map((element) => {
    const card = element as HTMLElement;
    return { id: card.dataset.widgetId, x: parseInt(card.style.left), y: parseInt(card.style.top), width: parseInt(card.style.width), height: parseInt(card.style.height) };
  }));
}
async function scale(page: Page) {
  return page.getByTestId('document-canvas').evaluate((element) => element.getBoundingClientRect().width / 1280);
}
async function drag(page: Page, id: string, dx: number, dy: number, release = true) {
  const box = (await card(page, id).boundingBox())!;
  const start = { x: box.x + 15, y: box.y + 15 };
  const factor = await scale(page);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + dx * factor, start.y + dy * factor, { steps: 4 });
  if (release) await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  // Keep every test offline, even if a local panel API happens to be available.
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Offline test"}' }));
  await page.goto('/');
  await expect(card(page, 'cpu')).toHaveCSS('left', '64px');
});

test('Shift selection from list and canvas preserves the group on focus and toggles without dragging', async ({ page }) => {
  const before = await geometry(page);
  await row(page, 'gpu').click({ modifiers: ['Shift'] });
  await expect(selected(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Resize CPU load', exact: true })).toHaveCount(0);
  await card(page, 'cpu').focus();
  await expect(selected(page)).toHaveCount(2);
  await expect(card(page, 'cpu')).toHaveAttribute('data-primary', 'true');
  await page.screenshot({ path: 'artifacts/canvas-tools-selection.png', fullPage: true });
  await card(page, 'weather').click({ modifiers: ['Shift'] });
  await expect(selected(page)).toHaveCount(3);
  await card(page, 'weather').click({ modifiers: ['Shift'] });
  await expect(selected(page)).toHaveCount(2);
  expect(await geometry(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await card(page, 'cpu').focus(); await page.keyboard.press('Control+a');
  await expect(selected(page)).toHaveCount(before.length);
});

test('native source selects keep Ctrl+A from changing selection or history', async ({ page }) => {
  const before = await geometry(page);
  await page.getByLabel('Panel data source', { exact: true }).focus();
  await page.keyboard.press('Control+a');
  await expect(selected(page)).toHaveCount(1);
  expect(await geometry(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await card(page, 'cpu').focus(); await page.keyboard.press('Control+a');
  await expect(selected(page)).toHaveCount(before.length);
});

test('stationary selection with Snap preserves geometry and the redo branch for single cards and groups', async ({ page }) => {
  const x = page.getByLabel('X position', { exact: true });
  await x.fill('26'); await x.press('Enter');
  await card(page, 'cpu').focus(); await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const before = await geometry(page);
  await page.getByRole('checkbox', { name: /Snap/ }).check();
  for (const grouped of [false, true]) {
    if (grouped) await row(page, 'gpu').click({ modifiers: ['Shift'] });
    const box = (await card(page, 'cpu').boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + 20);
    expect(await geometry(page)).toEqual(before);
    await expect(selected(page)).toHaveCount(grouped ? 2 : 1);
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await expect(page.getByTestId('snap-guide')).toHaveCount(0);
  }
});

test('group drag clamps as a unit, creates one undo and restores selection with redo intact', async ({ page }) => {
  const before = await geometry(page);
  await row(page, 'gpu').click({ modifiers: ['Shift'] });
  await drag(page, 'cpu', 2000, 2000);
  const after = await geometry(page);
  const cpu = after.find((widget) => widget.id === 'cpu')!;
  const gpu = after.find((widget) => widget.id === 'gpu')!;
  expect(cpu.x).toBe(552); expect(gpu.x).toBe(928);
  expect(cpu.y).toBe(576); expect(gpu.y).toBe(576);
  expect(gpu.x - cpu.x).toBe(376);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await geometry(page)).toEqual(before);
  await expect(selected(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await row(page, 'weather').click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await geometry(page)).toEqual(after);
  await expect(selected(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await drag(page, 'cpu', 20, 15, false);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await geometry(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
});

test('alignment, explicit distribution and paint layers use the whole selection', async ({ page }) => {
  await row(page, 'gpu').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Align left', exact: true }).click();
  await expect(card(page, 'gpu')).toHaveCSS('left', '64px');
  await page.getByRole('button', { name: 'Distribute horizontal 24 px', exact: true }).click();
  await expect(card(page, 'gpu')).toHaveCSS('left', '440px');
  await page.getByRole('button', { name: 'Send front', exact: true }).click();
  expect(await page.locator('[data-widget-id]').evaluateAll((elements) => elements.slice(-2).map((element) => (element as HTMLElement).dataset.widgetId))).toEqual(['cpu', 'gpu']);
  expect(await page.locator('[data-widget-row]').evaluateAll((elements) => elements.slice(0, 2).map((element) => (element as HTMLElement).dataset.widgetRow))).toEqual(['gpu', 'cpu']);
  await page.getByRole('button', { name: 'Send back', exact: true }).click();
  expect(await page.locator('[data-widget-id]').evaluateAll((elements) => elements.slice(0, 2).map((element) => (element as HTMLElement).dataset.widgetId))).toEqual(['cpu', 'gpu']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(selected(page)).toHaveCount(2);
});

test('zoom uses document pixels for pointer movement and keyboard group nudges', async ({ page }) => {
  await page.getByRole('checkbox', { name: 'Snapping', exact: true }).uncheck();
  await row(page, 'gpu').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByLabel('Canvas zoom')).toHaveText('125%');
  await drag(page, 'cpu', 1, 0);
  await expect(card(page, 'cpu')).toHaveCSS('left', '65px');
  await expect(card(page, 'gpu')).toHaveCSS('left', '441px');
  await card(page, 'cpu').focus(); await page.keyboard.press('ArrowRight');
  await expect(card(page, 'cpu')).toHaveCSS('left', '66px');
  await expect(card(page, 'gpu')).toHaveCSS('left', '442px');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(card(page, 'cpu')).toHaveCSS('top', '170px');
  await expect(card(page, 'gpu')).toHaveCSS('top', '170px');
  await page.screenshot({ path: 'artifacts/canvas-tools-zoom.png', fullPage: true });
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await drag(page, 'cpu', 1, 0);
  await expect(card(page, 'cpu')).toHaveCSS('left', '67px');
});

test('Space and middle-button pan are view-only, cancel safely and Fit resets the view', async ({ page }) => {
  const original = await geometry(page);
  const canvas = page.getByTestId('document-canvas');
  const initial = await canvas.boundingBox();
  const viewport = page.getByLabel('Canvas viewport');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.keyboard.down('Space');
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + 90, box.y + 70); await page.mouse.up(); await page.keyboard.up('Space');
  expect((await canvas.boundingBox())!.x).toBeCloseTo(initial!.x + 50, 0);
  expect(await geometry(page)).toEqual(original);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down({ button: 'middle' }); await page.mouse.move(box.x + 80, box.y + 60);
  await page.keyboard.press('Escape'); await page.mouse.up({ button: 'middle' });
  expect((await canvas.boundingBox())!.x).toBeCloseTo(initial!.x + 50, 0);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  expect((await canvas.boundingBox())!.x).toBeCloseTo(initial!.x, 0);
  await expect(page.getByLabel('Canvas zoom')).toHaveText('100%');
  expect(await geometry(page)).toEqual(original);
});

test('snapping starts enabled, remembers the choice and shows cancellable 24 px gutter guides', async ({ page }) => {
  const snapping = page.getByRole('checkbox', { name: 'Snapping', exact: true });
  await expect(snapping).toBeChecked();
  await snapping.uncheck();
  await page.reload();
  await expect(snapping).not.toBeChecked();
  await snapping.check();
  await drag(page, 'cpu', -38, 0, false);
  await expect(card(page, 'cpu')).toHaveCSS('left', '24px');
  await expect(page.getByTestId('snap-guide').first()).toBeVisible();
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(card(page, 'cpu')).toHaveCSS('left', '64px');
  await expect(page.getByTestId('snap-guide')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('size tools use the selected reference, preserve positions and undo as one edit', async ({ page }) => {
  await row(page, 'gpu').click();
  for (const [name, value] of [['Width', '280'], ['Height', '180']]) {
    const field = page.getByRole('textbox', { name, exact: true });
    await field.fill(value); await field.press('Enter');
  }
  await row(page, 'cpu').click({ modifiers: ['Shift'] });
  await card(page, 'gpu').focus();
  const before = await geometry(page);
  await expect(page.locator('.size-reference')).toContainText('GPU load');
  await page.getByRole('button', { name: 'Same width', exact: true }).click();
  await expect(card(page, 'cpu')).toHaveCSS('width', '280px');
  await expect(card(page, 'cpu')).toHaveCSS('height', '224px');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await geometry(page)).toEqual(before);
  await page.getByRole('button', { name: 'Same height', exact: true }).click();
  await expect(card(page, 'cpu')).toHaveCSS('height', '180px');
  await expect(card(page, 'cpu')).toHaveCSS('width', '352px');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Same size', exact: true }).click();
  const after = await geometry(page);
  expect(after.find((widget) => widget.id === 'cpu')).toEqual({ ...before.find((widget) => widget.id === 'cpu')!, width: 280, height: 180 });
  expect(after.filter((widget) => widget.id !== 'cpu')).toEqual(before.filter((widget) => widget.id !== 'cpu'));
  await page.screenshot({ path: 'artifacts/size-matching-tools.png', fullPage: true });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await geometry(page)).toEqual(before);
  await expect(selected(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await geometry(page)).toEqual(after);
  await row(page, 'cpu').click();
  await expect(page.getByRole('button', { name: 'Same size', exact: true })).toBeDisabled();
});

test('an impossible size match keeps the draft and history intact with an actionable error', async ({ page }) => {
  await row(page, 'gpu').click();
  const x = page.getByRole('textbox', { name: 'X position', exact: true });
  await x.fill('928'); await x.press('Enter');
  const width = page.getByRole('textbox', { name: 'Width', exact: true });
  await width.fill('100'); await width.press('Enter');
  // CPU's default 352px still fits exactly at x928, so enlarge the reference before grouping.
  await row(page, 'cpu').click();
  await width.fill('400'); await width.press('Enter');
  await row(page, 'gpu').click({ modifiers: ['Shift'] });
  await card(page, 'cpu').focus();
  const before = await geometry(page);
  await page.getByRole('button', { name: 'Same size', exact: true }).click();
  await expect(page.locator('.canvas-tool-error')).toContainText(/canvas/i);
  expect(await geometry(page)).toEqual(before);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card(page, 'cpu')).toHaveCSS('width', '352px');
});

async function resize(page: Page, dx: number, dy: number, release = true) {
  const box = (await page.getByRole('button', { name: 'Resize CPU load', exact: true }).boundingBox())!;
  const factor = await scale(page);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx * factor, y + dy * factor, { steps: 4 });
  if (release) await page.mouse.up();
  return { x, y };
}

test('resize snaps to matching dimensions at different zooms and preserves the stationary axis', async ({ page }) => {
  const width = page.getByRole('textbox', { name: 'Width', exact: true });
  await width.fill('300'); await width.press('Enter');
  await resize(page, 49, 0, false);
  await expect(card(page, 'cpu')).toHaveCSS('width', '352px');
  await expect(card(page, 'cpu')).toHaveCSS('height', '224px');
  await expect(page.getByTestId('snap-guide').first()).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('snap-guide')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card(page, 'cpu')).toHaveCSS('width', '300px');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await resize(page, 49, 0, false);
  await expect(card(page, 'cpu')).toHaveCSS('width', '352px');
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(card(page, 'cpu')).toHaveCSS('width', '300px');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Snapping', exact: true }).uncheck();
  await resize(page, 49, 0);
  await expect(card(page, 'cpu')).toHaveCSS('width', '349px');
});

test('stationary resize and returning to the original size preserve the redo branch', async ({ page }) => {
  const width = page.getByRole('textbox', { name: 'Width', exact: true });
  await width.fill('350'); await width.press('Enter');
  await width.fill('330'); await width.press('Enter');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Resize CPU load', exact: true }).click();
  await expect(card(page, 'cpu')).toHaveCSS('width', '350px');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  const start = await resize(page, 30, 0, false);
  await page.mouse.move(start.x, start.y);
  await page.mouse.up();
  await expect(card(page, 'cpu')).toHaveCSS('width', '350px');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await expect(page.getByTestId('snap-guide')).toHaveCount(0);
});

test('overlap and small-card notes are bounded and still allow JSON export', async ({ page }) => {
  await row(page, 'gpu').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Align left', exact: true }).click();
  await page.getByText('1 layout notes', { exact: true }).click();
  await expect(page.locator('.canvas-warnings')).toContainText('overlap');
  await row(page, 'cpu').click();
  const width = page.getByRole('textbox', { name: 'Width', exact: true });
  await width.fill('80'); await width.press('Enter');
  await expect(page.locator('.canvas-warnings')).toContainText('too small');
  expect(await page.locator('.canvas-warnings li').count()).toBeLessThanOrEqual(8);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await pending;
  const document = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(document.widgets.find((widget: { id: string }) => widget.id === 'cpu').width).toBe(80);
});

test('blur, lost capture, pointer cancellation and viewport resize restore the original group without history', async ({ page }) => {
  await page.getByRole('checkbox', { name: 'Snapping', exact: true }).uncheck();
  await row(page, 'gpu').click({ modifiers: ['Shift'] });
  const before = await geometry(page);
  for (const path of ['blur', 'lostpointercapture', 'pointercancel', 'resize']) {
    await drag(page, 'cpu', 20, 15, false);
    await expect(card(page, 'cpu')).toHaveCSS('left', '84px');
    if (path === 'resize') await page.setViewportSize({ width: 1400, height: 900 });
    else if (path === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else await card(page, 'cpu').evaluate((element, type) => element.dispatchEvent(new PointerEvent(type, { pointerId: 1, bubbles: true })), path);
    await page.mouse.up();
    await expect.poll(() => geometry(page), { message: `${path} cancels the complete group` }).toEqual(before);
    await expect(selected(page)).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  }
});


test('layout notes keep Save to panel available with a fully intercepted API', async ({ page }) => {
  let saved = createSampleLayout();
  let revision = 'test-initial';
  let writes = 0;
  await page.route('**/api/layout', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().headers()['if-match']).toBe('test-initial');
      saved = route.request().postDataJSON(); revision = 'test-saved'; writes++;
    }
    await route.fulfill({ json: { document: saved, revision } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: revision, appliedRevision: revision } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeEnabled();
  await row(page, 'gpu').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Align left', exact: true }).click();
  await expect(page.locator('.canvas-warnings summary')).toHaveText('1 layout notes');
  await page.getByRole('button', { name: 'Save to panel', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  expect(saved.widgets.find((widget) => widget.id === 'gpu')!.x).toBe(64);
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
});
