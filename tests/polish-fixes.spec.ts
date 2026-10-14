import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';
import type { GaugeWidget, LayoutDocument } from '../src/domain/layout';

async function open(page: Page, document: LayoutDocument) {
  await page.goto('/');
  await page.getByLabel('Open layout file', { exact: true }).setInputFiles({ name: 'test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  await expect(page.getByRole('textbox', { name: 'Layout name', exact: true })).toHaveValue(document.name);
}

const gauge = (style: GaugeWidget['settings']['style'], index: number): GaugeWidget => ({
  id: `gauge-${style}`, type: 'gauge', x: 16 + index * 248, y: 16, width: 232, height: 304,
  settings: { label: style ?? 'Arc', style, value: 42, min: 0, max: 100, unit: '%', detail: 'Sample' },
});

test('list sensor arrows keep focus and Content collapse persists across new card types', async ({ page }) => {
  const document = JSON.parse(await readFile('layouts/new-widgets-showcase.json', 'utf8')) as LayoutDocument;
  await open(page, document);
  await page.locator('[data-widget-row="system-list-1"]').click();
  const sensor = page.getByRole('combobox', { name: 'Row 1 sensor', exact: true });
  await sensor.focus();
  await sensor.press('ArrowDown');
  await expect(sensor).toBeFocused();
  await expect(sensor).toHaveValue('network-down');
  await sensor.press('ArrowDown');
  await expect(sensor).toBeFocused();
  await expect(sensor).toHaveValue('network-up');
  const content = page.locator('details.inspector-section').filter({ has: page.locator('summary h4', { hasText: /^Content$/ }) });
  await content.locator('summary').click();
  await expect(content).not.toHaveAttribute('open');
  for (const id of ['network-graph-2', 'calendar-3', 'system-list-1']) {
    await page.locator(`[data-widget-row="${id}"]`).click();
    await expect(content).toHaveCount(1);
    await expect(content).not.toHaveAttribute('open');
  }
  await content.locator('summary').click();
  await expect(sensor).toHaveValue('network-up');
});

test('number typing waits for Enter or blur while native steps commit immediately', async ({ page }) => {
  await open(page, { ...createSampleLayout(), widgets: [gauge('number', 0)] });
  await page.locator('[data-widget-row="gauge-number"]').click();
  const maximum = page.getByRole('spinbutton', { name: 'Maximum', exact: true });
  const bounds = page.locator('[data-widget-id="gauge-number"] .instrument-bound').last();
  await maximum.fill('200');
  await expect(bounds).toHaveText('100');
  await maximum.press('Enter');
  await expect(bounds).toHaveText('200');
  await maximum.fill('300');
  await expect(bounds).toHaveText('200');
  await maximum.blur();
  await expect(bounds).toHaveText('300');
  await maximum.focus();
  await maximum.press('ArrowUp');
  await expect(maximum).toBeFocused();
  await expect(bounds).toHaveText('301');
  await maximum.evaluate((element) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, '302');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: '' }));
  });
  await expect(bounds).toHaveText('302');
});

test('status dots and every instrument use palette colors', async ({ page }) => {
  const document = { ...createSampleLayout(), widgets: (['number', 'bar', 'segments', 'ring', 'thermometer'] as const).map(gauge) };
  await open(page, document);
  const dot = page.locator('.status-dot').first();
  const primary = await page.locator('main.studio').evaluate((element) => getComputedStyle(element).getPropertyValue('--primary').trim());
  await expect(dot).toHaveCSS('background-color', await page.evaluate((color) => { const element = window.document.createElement('span'); element.style.color = color; window.document.body.append(element); const result = getComputedStyle(element).color; element.remove(); return result; }, primary));
  for (const widget of document.widgets) {
    const instrument = page.locator(`[data-widget-id="${widget.id}"]`);
    const colors = await instrument.evaluate((element) => {
      const color = (role: string) => {
        const probe = window.document.createElement('span'); probe.style.color = `var(--${role})`; element.append(probe);
        const value = getComputedStyle(probe).color; probe.remove(); return value;
      };
      return { primary: color('primary'), outline: color('outline'), muted: color('muted') };
    });
    await expect(instrument.locator('.instrument-value')).toHaveCSS('fill', colors.primary);
    await expect(instrument.locator('.instrument-unit')).toHaveCSS('fill', colors.muted);
    if (widget.settings.style === 'ring') {
      await expect(instrument.locator('.instrument-track')).toHaveCSS('stroke', colors.outline);
      await expect(instrument.locator('.instrument-progress')).toHaveCSS('stroke', colors.primary);
    } else if (widget.settings.style !== 'number') {
      await expect(instrument.locator('.instrument-track').first()).toHaveCSS('fill', colors.outline);
      await expect(instrument.locator('.instrument-progress').first()).toHaveCSS('fill', colors.primary);
    }
  }
});

test('long preview errors wrap and expose their full message as status', async ({ page }) => {
  const error = 'Preview failed. ' + 'Check the layout and retry. '.repeat(7);
  await page.route('**/api/layout', (route) => route.fulfill({ json: { document: createSampleLayout(), revision: 'saved' } }));
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'saved', appliedRevision: 'saved' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error } }));
  await page.goto('/');
  const notice = page.locator('.canvas-status-notice');
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice).toContainText(error.trim());
  await expect(notice).toHaveCSS('white-space', 'normal');
  const box = await notice.boundingBox();
  expect(box!.height).toBeGreaterThan(40);
  expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('an arriving wrapped preview error preserves an active drag', async ({ page }) => {
  let releasePreview: (() => void) | undefined;
  const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
  let previewStarted = false;
  const error = 'Preview failed. ' + 'Check the layout and retry. '.repeat(7);
  await page.route('**/api/layout', (route) => route.fulfill({ json: { document: createSampleLayout(), revision: 'saved' } }));
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'saved', appliedRevision: 'saved' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', async (route) => {
    previewStarted = true;
    await previewGate;
    await route.fulfill({ status: 422, json: { error } });
  });
  await page.goto('/');
  await expect.poll(() => previewStarted).toBe(true);
  const card = page.getByRole('group', { name: 'CPU load card', exact: true });
  const bounds = (await card.boundingBox())!;
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const response = page.waitForResponse('**/api/preview');
  releasePreview!();
  await (await response).finished();
  await expect(page.locator('.canvas-status-notice')).toHaveText('Rendering sample preview…');
  await page.mouse.move(x + 30, y);
  await page.mouse.up();
  await expect(page.getByLabel('X position', { exact: true })).not.toHaveValue('64');
  await expect(page.locator('.canvas-status-notice')).toContainText(error.trim());
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
});
