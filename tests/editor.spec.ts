import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { gaugeStyles, validateLayout } from '../src/domain/layout';
import type { LayoutDocument } from '../src/domain/layout';
import sharedCatalog from '../public/widget-catalog.json' with { type: 'json' };

const samplePath = 'public/sample-layout.json';

test('AI usage preset is a demo draft with preserved live sources and no automatic apply', async ({ page }) => {
  let saves = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/layout') saves++; });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create layout', exact: true }).click();
  await page.getByRole('button', { name: 'Create AI usage', exact: true }).click();
  await expect(page.getByTestId('document-canvas').locator('.dashboard-header strong')).toHaveText('AI usage');
  await expect(page.locator('[data-widget-id="codex-tokens"] .usage-content')).toBeVisible();
  await expect(page.locator('[data-widget-id="codex-models"] .usage-model-row')).toHaveCount(2);
  await expect(page.locator('[data-widget-id="codex-models"] .usage-model-row').first()).toContainText('2.1M');
  await expect(page.locator('[data-widget-id="codex-models"] .usage-model-row').first()).toContainText('11.50');
  await expect(page.locator('[data-widget-id="claude-session-bar"] [data-gauge-style="bar"]')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await downloadPromise;
  const document = validateLayout(JSON.parse(await readFile((await download.path())!, 'utf8')));
  expect(document.name).toBe('AI usage');
  expect(document.widgets.filter((widget) => widget.type !== 'text' && /^(codex|claude)-/.test(widget.settings.source ?? ''))).toHaveLength(11);
  const cost = document.widgets.find((widget) => widget.id === 'codex-cost');
  expect(cost?.type === 'metric' ? cost.settings.detail : '').toContain('not a subscription bill');
  expect(saves).toBe(0);
});

test('storage library retains root gauges alongside mounted filesystem designs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add widget' });
  await dialog.getByRole('button', { name: /^Storage/ }).click();
  await expect(dialog.getByRole('button', { name: /^Add / })).toHaveCount(10);
  await dialog.getByRole('button', { name: 'Add Root storage ring', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Panel data source' })).toHaveValue('storage');
  await expect(page.getByRole('combobox', { name: 'Display style' })).toHaveValue('ring');
});
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

test('add, edit, duplicate, remove, undo, export and reopen expanded widgets offline', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await context.setOffline(true);
  const blank = JSON.parse(await readFile(samplePath, 'utf8')) as LayoutDocument;
  blank.widgets = [];
  await openJson(page, JSON.stringify(blank));
  await expect(page.getByText('This canvas is empty.', { exact: false })).toBeVisible();
  for (const name of ['Clock', 'Text', 'Gauge', 'CPU temperature', 'GPU temperature', 'Disk usage', 'Download', 'Upload']) {
    await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
  }
  await page.locator('[data-widget-row="clock"]').click();
  await field(page, 'Label').fill('Desk clock');
  await field(page, 'Label').press('Enter');
  await page.getByLabel('12-hour', { exact: true }).check();
  await expect(card(page, 'clock').locator('.clock-value')).toHaveText('2:32PM');
  await expect(page.locator('.document-canvas .dashboard-time')).toHaveCount(0);
  await page.getByLabel('Show date', { exact: true }).uncheck();
  await expect(card(page, 'clock').locator('.clock-date')).toHaveCount(0);
  await page.locator('[data-widget-row="text"]').click();
  await field(page, 'Label').fill('Desk note');
  await field(page, 'Label').press('Enter');
  await field(page, 'Text').fill('First line\nSecond line');
  await field(page, 'Label').click();
  await expect(card(page, 'text')).toContainText('Second line');
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(card(page, 'text-2')).toHaveAttribute('data-selected', 'true');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(card(page, 'text-2')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card(page, 'text-2')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.locator('[data-widget-row="gauge"]').click();
  await field(page, 'Value').fill('101');
  await field(page, 'Value').press('Enter');
  await expect(page.locator('.field-error')).toHaveText('must be between min and max');
  await field(page, 'Value').press('Escape');
  await field(page, 'Maximum').fill('200');
  await field(page, 'Maximum').press('Enter');
  await field(page, 'Value').fill('150.5');
  await field(page, 'Value').press('Enter');
  await page.getByLabel('Panel data source').selectOption('gpu-temperature');
  await field(page, 'Layout name').fill('My custom panel');
  await field(page, 'Layout name').press('Enter');
  const text = await exportJson(page);
  const saved = JSON.parse(text) as LayoutDocument;
  expect(saved.name).toBe('My custom panel');
  expect(saved.widgets).toHaveLength(8);
  expect(saved.widgets.find((widget) => widget.type === 'gauge')?.settings).toMatchObject({ value: 150.5, max: 200, source: 'gpu-temperature' });
  expect(saved.widgets.find((widget) => widget.type === 'text')?.settings).toEqual({ label: 'Desk note', text: 'First line\nSecond line' });
  await openJson(page, text);
  await page.getByRole('button', { name: 'Open and discard changes', exact: true }).click();
  expect(await exportJson(page)).toBe(text);
  expect(errors).toEqual([]);
});

test('layout presets protect dirty drafts, preserve palette, and support an empty canvas', async ({ page }) => {
  const preset = JSON.parse(await readFile(samplePath, 'utf8')) as LayoutDocument;
  preset.name = 'Blank canvas'; preset.widgets = [];
  await page.route('**/layout-presets.json', (route) => route.fulfill({ json: { presets: [{ id: 'blank', name: 'Blank canvas', description: 'Start with an empty canvas.', document: preset }] } }));
  await page.goto('/');
  await page.getByLabel('Import palette file', { exact: true }).setInputFiles({ name: 'scheme.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ name: 'Personal palette', colours: {
    background: '0a0f0f', surfaceContainer: '131b1b', surfaceContainerHigh: '192121', onSurface: 'dce8e7', onSurfaceVariant: 'a2adad', primary: 'aa88bb', secondary: 'b0cccc', outlineVariant: '3f4a4a',
  } })) });
  await page.getByRole('button', { name: 'Create layout', exact: true }).click();
  await page.getByRole('button', { name: 'Create Blank canvas', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Replace unsaved changes?');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(card(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Create layout', exact: true }).click();
  await page.getByRole('button', { name: 'Create Blank canvas', exact: true }).click();
  await page.getByRole('button', { name: 'Create and discard changes', exact: true }).click();
  await expect(page.locator('[data-widget-id]')).toHaveCount(0);
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
  const saved = JSON.parse(await exportJson(page)) as LayoutDocument;
  expect(saved.name).toBe('Blank canvas');
  expect(saved.palette.primary).toBe('#aa88bb');
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  await page.getByRole('button', { name: 'Add Clock', exact: true }).click();
  await expect(card(page, 'clock')).toBeFocused();
  const x = await field(page, 'X position').inputValue();
  await page.keyboard.press('ArrowRight');
  await expect(field(page, 'X position')).toHaveValue(String(Number(x) + 1));
});

test('widget library browses all choices and combines case-insensitive search with categories', async ({ page }) => {
  await page.goto('/');
  const add = page.getByRole('button', { name: 'Add widget', exact: true });
  await add.click();
  const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
  const choices = library.getByRole('button', { name: /^Add / });
  const search = library.getByLabel('Search widgets', { exact: true });
  await expect(choices).toHaveCount(sharedCatalog.widgets.length);
  for (const entry of sharedCatalog.widgets) {
    const choice = library.getByRole('button', { name: `Add ${entry.name}`, exact: true });
    await expect(choice).toHaveCount(1);
    await expect(choice).toContainText(entry.variant);
    await expect(choice).toContainText(`${entry.width} × ${entry.height}`);
    await expect(choice).toContainText(entry.description);
  }
  for (const group of sharedCatalog.groups) {
    const category = library.getByRole('button', { name: new RegExp(`^${group.name}`) });
    await category.click();
    await expect(category).toHaveAttribute('aria-pressed', 'true');
    await expect(choices).toHaveCount(sharedCatalog.widgets.filter((entry) => entry.group === group.id).length);
  }
  await library.getByRole('button', { name: /^All widgets/ }).click();
  await expect(library.getByRole('button', { name: /^All widgets/ })).toHaveAttribute('aria-pressed', 'true');
  await search.fill('cPu');
  const cpuEntries = sharedCatalog.widgets.filter((entry) => [entry.name, entry.family, entry.variant, entry.description, entry.id].filter(Boolean).join(' ').toLowerCase().includes('cpu'));
  // CPU search spans the system readings, temperatures and gauge choices.
  await expect(library.getByRole('button', { name: 'Add CPU load wide', exact: true })).toHaveCount(1);
  await expect(library.getByRole('button', { name: 'Add CPU temperature gauge', exact: true })).toHaveCount(1);
  await expect(library.getByRole('button', { name: 'Add Upload', exact: true })).toHaveCount(0);
  expect(await choices.count()).toBeGreaterThanOrEqual(cpuEntries.length);
  await library.getByRole('button', { name: /^System/ }).click();
  await expect(choices).toHaveCount(2);
  await expect(library.getByRole('button', { name: /^System/ })).toHaveAttribute('aria-pressed', 'true');
  await search.fill('WiDe');
  await expect(choices).toHaveCount(4);
  await library.getByRole('button', { name: /^Network/ }).click();
  await expect(choices).toHaveCount(2);
  await expect(library.getByRole('button', { name: 'Add Download wide', exact: true })).toHaveCount(1);
  await search.fill('no such widget xyz');
  await expect(choices).toHaveCount(0);
  await expect(library).toContainText(/No widgets/);
  await library.getByRole('button', { name: /Clear search/ }).click();
  await expect(search).toHaveValue('');
  await expect(choices).toHaveCount(4);
  await library.getByRole('button', { name: /^All widgets/ }).click();
  await expect(choices).toHaveCount(sharedCatalog.widgets.length);
  await library.getByRole('button', { name: 'Close widget catalog', exact: true }).click();
  await expect(add).toBeFocused();
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
});

test('CPU library previews draw distinct instruments and style changes preserve the saved widget', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
  const ids = ['cpu-gauge', 'cpu-ring', 'cpu-bar', 'cpu-segments', 'cpu-number', 'cpu-temperature-thermometer'];
  for (const id of ids) {
    const entry = sharedCatalog.widgets.find((entry) => entry.id === id)!;
    const specimen = library.getByRole('button', { name: `Add ${entry.name}`, exact: true }).locator('.gauge-content');
    await expect(specimen).toHaveAttribute('data-gauge-style', entry.settings.style ?? 'arc');
    if (id === 'cpu-gauge') await expect(specimen.locator('path')).toHaveCount(2);
    if (id === 'cpu-ring') await expect(specimen.locator('circle')).toHaveCount(2);
    if (id === 'cpu-bar') await expect(specimen.locator('rect')).toHaveCount(2);
    if (id === 'cpu-segments') await expect(specimen.locator('[data-segment]')).toHaveCount(16);
    if (id === 'cpu-number') await expect(specimen.locator('path, circle, rect')).toHaveCount(0);
    if (id === 'cpu-temperature-thermometer') {
      await expect(specimen.locator('circle')).toHaveCount(2);
      await expect(specimen.locator('rect')).toHaveCount(2);
    }
  }
  await library.getByRole('button', { name: 'Add CPU load gauge', exact: true }).click();
  const original = JSON.parse(await exportJson(page)) as LayoutDocument;
  const gauge = original.widgets.find((widget) => widget.id === 'cpu-gauge')!;
  expect(gauge.settings).not.toHaveProperty('style');
  const pictures: Buffer[] = [];
  for (const style of gaugeStyles) {
    await page.getByLabel('Display style', { exact: true }).selectOption(style);
    await expect(card(page, gauge.id).locator('.gauge-content')).toHaveAttribute('data-gauge-style', style);
    const saved = JSON.parse(await exportJson(page)) as LayoutDocument;
    expect(saved.widgets.find((widget) => widget.id === gauge.id)).toEqual(style === 'arc' ? gauge : { ...gauge, settings: { ...gauge.settings, style } });
    pictures.push(await card(page, gauge.id).locator('.gauge-content').screenshot());
  }
  expect(new Set(pictures.map((buffer) => buffer.toString('base64'))).size).toBe(6);
  await expect(page.locator('input[aria-label="undefined"]')).toHaveCount(0);
  const saved = await exportJson(page);
  await openJson(page, saved);
  await page.getByRole('button', { name: 'Open and discard changes', exact: true }).click();
  expect(await exportJson(page)).toBe(saved);
  await page.locator('[data-widget-row="cpu-gauge"]').click();
  await expect(page.getByLabel('Display style', { exact: true })).toHaveValue('number');
});

for (const viewport of [{ width: 1024, height: 640 }, { width: 390, height: 844 }]) {
test(`scrolling the library reaches the final choice at ${viewport.width}px while controls remain available`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.goto('/');
  const blank = JSON.parse(await readFile(samplePath, 'utf8')) as LayoutDocument;
  blank.widgets = [];
  await openJson(page, JSON.stringify(blank));
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
  const last = library.getByRole('button', { name: /^Add / }).last();
  await expect(last).toHaveAccessibleName(`Add ${sharedCatalog.widgets.at(-1)!.name}`);
  expect(await library.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  const before = await library.evaluate((dialog) => {
    return [...dialog.querySelectorAll<HTMLElement>('*')].filter((element) => /auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight)
      .map((element) => ({ top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight }));
  });
  expect(before.length).toBeGreaterThan(0);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(library.getByLabel('Search widgets', { exact: true })).toBeInViewport();
  await expect(library.getByRole('button', { name: 'Close widget catalog', exact: true })).toBeInViewport();
  const scrollTops = await library.evaluate((dialog) => [...dialog.querySelectorAll<HTMLElement>('*')].map((element) => element.scrollTop));
  expect(scrollTops.some((top) => top > 0)).toBe(true);
  await last.click();
  const finalTemplate = sharedCatalog.widgets.at(-1)!;
  await expect(card(page, finalTemplate.id)).toBeFocused();
  await expect(field(page, 'Width')).toHaveValue(String(finalTemplate.width));
  await expect(field(page, 'Height')).toHaveValue(String(finalTemplate.height));
  const saved = JSON.parse(await exportJson(page)) as LayoutDocument;
  expect(validateLayout(saved)).toEqual(saved);
  expect(saved.widgets[0]).toMatchObject({ id: finalTemplate.id, type: finalTemplate.type, width: finalTemplate.width, height: finalTemplate.height, settings: finalTemplate.settings });
  for (const value of Object.values((await geometry(page))[0]).filter((value) => typeof value === 'number')) expect(Number.isInteger(value)).toBe(true);
});
}

test('keyboard browsing keeps focus inside the library and Escape or close restores the opener', async ({ page }) => {
  await page.goto('/');
  const add = page.getByRole('button', { name: 'Add widget', exact: true });
  await add.focus();
  await page.keyboard.press('Enter');
  const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
  await expect(library).toBeVisible();
  const search = library.getByLabel('Search widgets', { exact: true });
  await search.focus();
  await page.keyboard.type('12-hour');
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(library).toBeVisible();
  await page.keyboard.type('12-hour');
  const choice = library.getByRole('button', { name: 'Add 12-hour clock', exact: true });
  await expect(choice).toHaveCount(1);
  let reachedChoice = false;
  for (let step = 0; step < 20; step++) {
    await page.keyboard.press('Tab');
    expect(await library.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    if (await choice.evaluate((button) => button === document.activeElement)) { reachedChoice = true; break; }
  }
  expect(reachedChoice).toBe(true);
  await page.keyboard.press('Escape');
  await expect(library).not.toBeVisible();
  await expect(add).toBeFocused();
  await page.keyboard.press('Enter');
  await library.getByRole('button', { name: 'Close widget catalog', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(add).toBeFocused();
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  await page.keyboard.press('Enter');
  await choice.focus();
  await page.keyboard.press('Enter');
  await expect(card(page, 'clock-12h')).toBeFocused();
  await expect(page.getByLabel('12-hour', { exact: true })).toBeChecked();
  const x = Number(await field(page, 'X position').inputValue());
  await page.keyboard.press('ArrowRight');
  await expect(field(page, 'X position')).toHaveValue(String(x + 1));
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
});

test('offline variant additions export and reopen exact sources, ranges, settings and integer geometry', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await context.setOffline(true);
  const blank = JSON.parse(await readFile(samplePath, 'utf8')) as LayoutDocument;
  blank.widgets = [];
  await openJson(page, JSON.stringify(blank));
  const ids = ['cpu-wide', 'memory-gauge', 'network-down-gauge', 'gpu-temperature-gauge', 'clock-12h', 'weather-tall', 'text-note'];
  for (const id of ids) {
    const entry = sharedCatalog.widgets.find((entry) => entry.id === id)!;
    await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
    await library.getByRole('button', { name: `Add ${entry.name}`, exact: true }).click();
    await expect(card(page, id)).toBeFocused();
    await expect(card(page, id)).toHaveAttribute('data-selected', 'true');
  }
  const first = await exportJson(page);
  const saved = JSON.parse(first) as LayoutDocument;
  expect(saved.widgets.map(({ id }) => id)).toEqual(ids);
  expect(validateLayout(saved)).toEqual(saved);
  for (const widget of saved.widgets) {
    const entry = sharedCatalog.widgets.find((entry) => entry.id === widget.id)!;
    expect(widget.settings).toEqual(entry.settings);
    expect([widget.x, widget.y, widget.width, widget.height].every(Number.isSafeInteger)).toBe(true);
    expect(widget.x + widget.width).toBeLessThanOrEqual(saved.canvas.width);
    expect(widget.y + widget.height).toBeLessThanOrEqual(saved.canvas.height);
  }
  await page.locator('[data-widget-row="network-down-gauge"]').click();
  await expect(field(page, 'Maximum')).toHaveValue('1024');
  await expect(page.getByLabel('Panel data source')).toHaveValue('network-down');
  await field(page, 'Maximum').fill('100');
  await field(page, 'Maximum').press('Enter');
  await expect(page.locator('.field-error')).toHaveText('must be between min and max');
  await field(page, 'Maximum').press('Escape');
  expect(await exportJson(page)).toBe(first);
  await openJson(page, first);
  await page.getByRole('button', { name: 'Open and discard changes', exact: true }).click();
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  expect(await exportJson(page)).toBe(first);
  expect(errors).toEqual([]);
});

test('mounted storage can be added, restyled, exported and reopened without applying to panel', async ({ page }) => {
  let saves = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/layout') saves++; });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add widget' });
  await dialog.getByRole('button', { name: /^Storage/ }).click();
  await dialog.getByRole('searchbox', { name: /Search widgets/ }).fill('Mounted storage');
  await expect(dialog.getByRole('button', { name: /^Add / })).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Add Mounted storage wide', exact: true }).click();
  const mounted = card(page, 'mounted-storage-wide');
  await expect(mounted.locator('[data-storage-style="bars"]')).toBeVisible();
  await expect(mounted).toContainText('/mnt/games');
  await expect(mounted).toContainText('/mnt/nvme');
  await expect(mounted).toContainText('/mnt/hdd');
  await expect(mounted).toContainText('/home');
  await expect(page.getByRole('combobox', { name: 'Panel data source' })).toHaveValue('mounted-storage');
  await page.getByRole('combobox', { name: 'Display style' }).selectOption('table');
  await expect(mounted.locator('[data-storage-style="table"]')).toBeVisible();
  await expect(mounted).toContainText('Used / total');
  const doc = validateLayout(JSON.parse(await exportJson(page)));
  const widget = doc.widgets.find((widget) => widget.id === 'mounted-storage-wide');
  expect(widget?.settings).toEqual({ label: 'Mounted storage', style: 'table', source: 'mounted-storage' });
  await openJson(page, JSON.stringify(doc));
  await expect(mounted.locator('[data-storage-style="table"]')).toBeVisible();
  expect(saves).toBe(0);
});
