import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';
import type { LayoutDocument } from '../src/domain/layout';

const card = (page: Page, id: string) => page.locator(`[data-widget-id="${id}"]`);

async function library(page: Page) {
  const panel = createSampleLayout();
  const focus = createSampleLayout(); focus.name = 'Focus';
  const gaming: LayoutDocument = { ...createSampleLayout(), name: 'Gaming', widgets: createSampleLayout().widgets.filter((widget) => widget.id === 'weather') };
  const entries = [{ id: 'focus', name: 'Focus', document: focus }, { id: 'gaming', name: 'Gaming', document: gaming }];
  let revision = 'library-1';
  await page.route('**/api/layout', (route) => route.fulfill({ json: { document: panel, revision: 'panel-1' } }));
  await page.route('**/api/layouts', (route) => {
    if (route.request().method() === 'POST') {
      if (route.request().headers()['if-match'] !== revision) return route.fulfill({ status: 409, json: { error: 'Library changed', revision } });
      entries.splice(0, entries.length, ...route.request().postDataJSON().entries);
      revision = `library-${Number(revision.slice(8)) + 1}`;
    }
    return route.fulfill({ json: { entries, revision, activeId: null } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'panel-1', appliedRevision: 'panel-1' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Fixture uses local preview' } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Library', exact: true })).toBeVisible();
  return entries;
}

async function editEntry(page: Page, name: string) {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Library', exact: true });
  await dialog.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: 'Edit as draft', exact: true }).click();
  await expect(page.getByLabel('Layout name')).toHaveValue(name);
}

test('copy a card in one saved layout, paste it into another and undo the paste', async ({ page }) => {
  const entries = await library(page);
  await editEntry(page, 'Focus');
  await card(page, 'cpu').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+c');
  await expect(page.getByRole('status').filter({ hasText: 'Copied CPU load.' })).toBeVisible();

  await editEntry(page, 'Gaming');
  await expect(page.locator('[data-widget-id]')).toHaveCount(1);
  await page.keyboard.press('Control+v');
  await expect(card(page, 'cpu')).toHaveAttribute('data-selected', 'true');
  await expect(page.getByLabel('X position')).toHaveValue('64');
  await expect(page.getByLabel('Y position')).toHaveValue('160');
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');

  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect.poll(() => entries.find((entry) => entry.id === 'gaming')!.document.widgets.map((widget) => widget.id)).toEqual(['weather', 'cpu']);
  expect(entries.find((entry) => entry.id === 'focus')!.document.widgets).toHaveLength(4);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card(page, 'cpu')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(card(page, 'cpu')).toHaveCount(1);
});

test('the clipboard tray keeps recent copies across reloads and pastes, saves or removes one', async ({ page }) => {
  await page.goto('/');
  const toolbar = page.getByRole('group', { name: 'Selection actions', exact: true });
  await card(page, 'cpu').click({ position: { x: 20, y: 20 } });
  await toolbar.getByRole('button', { name: 'Copy selected widget', exact: true }).click();
  await card(page, 'gpu').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+x');
  await expect(card(page, 'gpu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clipboard, 2 copies', exact: true })).toBeVisible();

  // Text fields keep their own copy and paste.
  await page.getByLabel('Layout name').focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-widget-id]')).toHaveCount(3);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card(page, 'gpu')).toHaveCount(1);
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  await page.reload();
  await expect(page.locator('[data-widget-id]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Clipboard, 2 copies', exact: true }).click();
  const tray = page.getByRole('region', { name: 'Clipboard', exact: true });
  await expect(tray.getByRole('listitem')).toHaveCount(2);
  await expect(tray.getByRole('listitem').first()).toContainText('GPU load');
  await expect(tray.getByRole('listitem').first()).toContainText('Ctrl+V pastes this one');

  await tray.getByRole('button', { name: 'Paste CPU load', exact: true }).click();
  await expect(tray).toBeHidden();
  await expect(card(page, 'cpu-2')).toHaveAttribute('data-selected', 'true');
  await expect(card(page, 'cpu-2')).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Pasted CPU load' })).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(card(page, 'cpu-2')).toHaveCount(0);

  await page.getByRole('button', { name: 'Clipboard, 2 copies', exact: true }).click();
  await tray.getByRole('button', { name: 'Remove GPU load from clipboard', exact: true }).click();
  await expect(tray.getByRole('listitem')).toHaveCount(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('turzx-studio.widget-clipboard.v1')!).entries.length)).toBe(1);
  await tray.getByRole('button', { name: 'Save CPU load as custom widget', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save as custom widget', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Clipboard, 1 copy', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(tray).toBeHidden();
  await expect(page.getByRole('button', { name: 'Clipboard, 1 copy', exact: true })).toBeFocused();
});

test('pasting a group into a full canvas keeps every card inside it and Undo is one step', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('group', { name: 'CPU load card' }).click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(page.locator('[data-widget-id]')).toHaveCount(8);
  await expect(page.locator('[data-widget-id][data-selected="true"]')).toHaveCount(4);
  await expect(page.getByRole('status').filter({ hasText: 'offset by 24 px' })).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-widget-id]')).toHaveCount(4);
});

test('cut warns immediately when browser storage fails and remains undoable', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'turzx-studio.widget-clipboard.v1') throw new DOMException('Full', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  await page.goto('/');
  await card(page, 'cpu').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+x');
  await expect(card(page, 'cpu')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /Cut CPU load.*only in this tab.*Undo restores/i })).toBeVisible();
  await page.keyboard.press('Control+v');
  await expect(card(page, 'cpu')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(card(page, 'cpu')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(card(page, 'cpu')).toHaveCount(1);
});

test('a tab-only copy survives another tab copying and clearing the shared clipboard', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'turzx-studio.widget-clipboard.v1') throw new DOMException('Full', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  await card(page, 'cpu').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+c');
  const other = await context.newPage();
  await other.goto('/');
  await card(other, 'gpu').click({ position: { x: 20, y: 20 } });
  await other.keyboard.press('Control+c');
  await expect(page.getByRole('button', { name: 'Clipboard, 2 copies', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clipboard, 2 copies', exact: true }).click();
  const tray = page.getByRole('region', { name: 'Clipboard', exact: true });
  await expect(tray.getByRole('listitem').first()).toContainText('GPU load');
  await expect(tray.getByRole('listitem').last()).toContainText('CPU load');
  await expect(tray.getByRole('status')).toContainText('only in this tab');
  await other.getByRole('button', { name: 'Clipboard, 1 copy', exact: true }).click();
  await other.getByRole('button', { name: 'Clear clipboard', exact: true }).click();
  await expect(tray.getByRole('listitem')).toHaveCount(1);
  await tray.getByRole('button', { name: 'Paste CPU load', exact: true }).click();
  await expect(card(page, 'cpu-2')).toHaveCount(1);
  await other.close();
});

test('clearing shared history removes persisted copies while retaining a failed copy in its tab', async ({ page, context }) => {
  await page.goto('/');
  await card(page, 'gpu').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+c');
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'turzx-studio.widget-clipboard.v1') throw new DOMException('Full', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  await card(page, 'cpu').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+c');
  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: 'Clipboard, 1 copy', exact: true }).click();
  await other.getByRole('button', { name: 'Clear clipboard', exact: true }).click();
  await page.getByRole('button', { name: 'Clipboard, 1 copy', exact: true }).click();
  const tray = page.getByRole('region', { name: 'Clipboard', exact: true });
  await expect(tray.getByRole('listitem')).toHaveCount(1);
  await expect(tray.getByRole('listitem')).toContainText('CPU load');
  await other.close();
});

test('quota trimming keeps older copies in this tab across shared history updates', async ({ page, context }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'turzx-studio.widget-clipboard.v1' && JSON.parse(value).entries.length > 1) throw new DOMException('Full', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  await page.goto('/');
  for (const id of ['cpu', 'gpu']) {
    await card(page, id).click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Control+c');
  }
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByRole('button', { name: 'Clipboard, 1 copy', exact: true })).toBeVisible();
  await card(other, 'weather').click({ position: { x: 20, y: 20 } });
  await other.keyboard.press('Control+c');
  await page.getByRole('button', { name: 'Clipboard, 3 copies', exact: true }).click();
  const items = page.getByRole('region', { name: 'Clipboard', exact: true }).getByRole('listitem');
  await expect(items).toHaveCount(3);
  await expect(items.first()).toContainText('Paris');
  await expect(items.last()).toContainText('CPU load');
  await other.close();
});

for (const action of ['remove first', 'remove last', 'remove only', 'clear'] as const) {
  test(`clipboard keeps keyboard focus after ${action}`, async ({ page }) => {
    await page.goto('/');
    await card(page, 'cpu').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Control+c');
    if (action !== 'remove only') {
      await card(page, 'gpu').click({ position: { x: 20, y: 20 } });
      await page.keyboard.press('Control+c');
    }
    await page.getByRole('button', { name: /^Clipboard,/ }).click();
    const tray = page.getByRole('region', { name: 'Clipboard', exact: true });
    if (action === 'clear') await tray.getByRole('button', { name: 'Clear clipboard', exact: true }).click();
    else await tray.getByRole('button', { name: `Remove ${action === 'remove first' ? 'GPU' : 'CPU'} load from clipboard`, exact: true }).click();
    if (action === 'clear' || action === 'remove only') await expect(tray.getByRole('button', { name: 'Close clipboard', exact: true })).toBeFocused();
    else await expect(tray.getByRole('button', { name: `Remove ${action === 'remove first' ? 'CPU' : 'GPU'} load from clipboard`, exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(tray).toBeHidden();
    await expect(page.getByRole('button', { name: /^Clipboard,/ })).toBeFocused();
  });
}

for (const viewport of [{ width: 360, height: 740 }, { width: 1280, height: 800 }, { width: 1600, height: 1000 }]) {
  test(`clipboard controls fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await card(page, 'cpu').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Control+c');
    await page.getByRole('button', { name: 'Clipboard, 1 copy', exact: true }).click();
    const tray = page.getByRole('region', { name: 'Clipboard', exact: true });
    const clear = tray.getByRole('button', { name: 'Clear clipboard', exact: true });
    await clear.scrollIntoViewIfNeeded();
    const bounds = (await tray.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    await expect(clear).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `artifacts/ui-simplify/fix-tray-${viewport.width}x${viewport.height}.png` });
  });
}
