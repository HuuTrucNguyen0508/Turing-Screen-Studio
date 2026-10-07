import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';

async function clock(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
  await library.getByLabel('Search widgets', { exact: true }).fill('Clock centered');
  // The catalog uses the same placement math as edited clocks.
  await library.getByRole('button', { name: /Add Clock.*Centered|Add Centered clock/i }).click();
}

test('clock design edits preserve geometry and sources, undo, and reject fractional offsets', async ({ page }) => {
  await clock(page);
  const x = await page.getByLabel('X position').inputValue();
  const width = await page.getByLabel('Width', { exact: true }).inputValue();
  const card = page.locator('[data-widget-id="clock-centered"]');
  await page.locator('.design-section summary').click();
  await page.locator('.design-element-row').filter({ hasText: 'Time' }).click();
  await page.getByRole('button', { name: 'Right', exact: true }).click();
  await expect(card.locator('text[data-element="time"]')).toHaveAttribute('text-anchor', 'end');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card.locator('text[data-element="time"]')).toHaveAttribute('text-anchor', 'middle');
  await expect(page.getByLabel('X position')).toHaveValue(x);
  await expect(page.getByLabel('Width', { exact: true })).toHaveValue(width);
  await page.getByLabel('X offset', { exact: true }).fill('1.5');
  await page.getByLabel('X offset', { exact: true }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('whole number');
  await page.getByLabel('X offset', { exact: true }).press('Escape');
  await expect(page.getByLabel('X offset', { exact: true })).toHaveValue('0');
});

test('custom clock copies survive reload and removing the template leaves placed cards unchanged', async ({ page }) => {
  await clock(page);
  await page.getByRole('button', { name: 'Save as custom widget…', exact: true }).click();
  const save = page.getByRole('dialog', { name: 'Save as custom widget', exact: true });
  await save.getByLabel('Custom widget name', { exact: true }).fill('My centered clock');
  await save.getByRole('button', { name: 'Save widget', exact: true }).click();
  await expect(save).not.toBeVisible();
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
  await library.getByLabel('Search widgets', { exact: true }).fill('My centered clock');
  await library.getByRole('button', { name: 'Add My centered clock', exact: true }).click();
  const placed = page.locator('[data-widget-id="my-centered-clock"]');
  await expect(placed.locator('text[data-element="time"]')).toHaveAttribute('text-anchor', 'middle');
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  await library.getByRole('button', { name: 'Manage custom widgets', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Custom widgets', exact: true });
  await manager.getByRole('button', { name: 'Remove…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Remove custom widget', exact: true }).getByRole('button', { name: 'Remove custom widget', exact: true }).click();
  await expect(manager).not.toContainText('My centered clock');
  await manager.getByRole('button', { name: 'Close custom widgets', exact: true }).click();
  await library.getByRole('button', { name: 'Close widget catalog', exact: true }).click();
  await expect(placed.locator('text[data-element="time"]')).toHaveAttribute('text-anchor', 'middle');
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover a draft' }).getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(placed.locator('text[data-element="time"]')).toHaveAttribute('text-anchor', 'middle');
});

test('browser templates remain accessible after connecting to machine storage without an automatic merge', async ({ page }) => {
  const template = (id: string, name: string) => ({ id, name, widget: { type: 'text', width: 240, height: 120, settings: { label: name, text: 'A reusable note' } } });
  const browser = { version: 1, widgets: [template('browser-note', 'Browser note')] };
  const machine = { version: 1, widgets: [template('machine-note', 'Machine note')], revision: 'templates-1' };
  let writes = 0;
  await page.addInitScript((value) => localStorage.setItem('turzx-studio.custom-widgets.v1', JSON.stringify(value)), browser);
  await page.route('**/api/layout', (route) => route.fulfill({ json: { document: createSampleLayout(), revision: 'panel' } }));
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Use local preview' } }));
  await page.route('**/api/widgets', (route) => { if (route.request().method() === 'POST') writes++; return route.fulfill({ json: machine }); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  await page.getByRole('button', { name: 'Manage custom widgets', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Custom widgets', exact: true });
  await expect(manager.getByRole('heading', { name: 'Machine note', exact: true })).toBeVisible();
  await manager.getByRole('button', { name: 'Show browser widgets', exact: true }).click();
  await expect(manager.getByRole('heading', { name: 'Browser note', exact: true })).toBeVisible();
  await expect(manager.getByRole('heading', { name: 'Machine note', exact: true })).toHaveCount(0);
  await manager.getByRole('button', { name: 'Show machine widgets', exact: true }).click();
  await expect(manager.getByRole('heading', { name: 'Machine note', exact: true })).toBeVisible();
  expect(writes).toBe(0);
});

for (const mode of ['browser', 'server'] as const) {
  test(`a delayed import cannot overwrite a newer rename in ${mode} storage`, async ({ page }) => {
    const template = (id: string, name: string) => ({ id, name, widget: { type: 'text', width: 240, height: 120, settings: { label: name, text: name } } });
    let current = { version: 1, widgets: [template('a', 'Template A')] };
    let revision = 'templates-1';
    if (mode === 'browser') await page.addInitScript((value) => localStorage.setItem('turzx-studio.custom-widgets.v1', JSON.stringify(value)), current);
    else {
      await page.route('**/api/layout', (route) => route.fulfill({ json: { document: createSampleLayout(), revision: 'panel' } }));
      await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true } }));
      await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
      await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Use local preview' } }));
      await page.route('**/api/widgets', (route) => {
        if (route.request().method() === 'POST') {
          if (route.request().headers()['if-match'] !== revision) return route.fulfill({ status: 409, json: { error: 'Templates changed' } });
          current = route.request().postDataJSON(); revision = 'templates-2';
        }
        return route.fulfill({ json: { ...current, revision } });
      });
    }
    await page.goto('/');
    await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    await page.getByRole('button', { name: 'Manage custom widgets', exact: true }).click();
    const manager = page.getByRole('dialog', { name: 'Custom widgets', exact: true });
    await expect(manager.getByRole('heading', { name: 'Template A', exact: true })).toBeVisible();
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = async function () {
        const text = await original.call(this);
        await new Promise<void>((resolve) => { (window as unknown as { releaseImport: () => void }).releaseImport = resolve; });
        return text;
      };
    });
    await manager.getByLabel('Import custom widgets file').setInputFiles({ name: 'widgets.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, widgets: [template('b', 'Template B')] })) });
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseImport?: () => void }).releaseImport)).toBe('function');
    await manager.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByLabel('Custom widget name', { exact: true }).fill('Renamed A');
    await page.getByRole('button', { name: 'Save widget', exact: true }).click();
    await expect(manager.getByRole('heading', { name: 'Renamed A', exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { releaseImport: () => void }).releaseImport());
    await expect(manager.getByRole('alert')).toContainText('changed while this operation was prepared');
    await expect(manager.getByRole('heading', { name: 'Renamed A', exact: true })).toBeVisible();
    const stored = mode === 'browser' ? await page.evaluate(() => JSON.parse(localStorage.getItem('turzx-studio.custom-widgets.v1')!)) : current;
    expect(stored.widgets.map((entry: { name: string }) => entry.name)).toEqual(['Renamed A']);
  });
}
