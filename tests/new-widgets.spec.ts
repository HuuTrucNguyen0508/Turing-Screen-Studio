import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { createSampleLayout, validateLayout } from '../src/domain/layout';
import type { CalendarWidget, GraphWidget, ListWidget } from '../src/domain/layout';

const card = (page: Page, id: string) => page.locator(`[data-widget-id="${id}"]`);

async function add(page: Page, search: string, name: string) {
  await page.getByRole('button', { name: 'Add widget', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add widget' });
  await dialog.getByRole('searchbox', { name: 'Search widgets' }).fill(search);
  await dialog.getByRole('button', { name: `Add ${name}`, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function exportJson(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  return readFile((await (await downloadPromise).path())!, 'utf8');
}

test('adds list, graph and calendar cards, edits them in the inspector and reopens the export', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Open layout file', { exact: true }).setInputFiles({ name: 'blank.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...createSampleLayout(), widgets: [] })) });
  await expect(page.getByText('This canvas is empty.', { exact: false })).toBeVisible();

  await add(page, 'list', 'System list');
  const list = card(page, 'system-list');
  await expect(list.locator('[data-list-row]')).toHaveCount(4);
  await expect(list.locator('.sensor-bar')).toHaveCount(4);
  await page.getByRole('button', { name: 'Add row', exact: true }).click();
  await expect(list.locator('[data-list-row]')).toHaveCount(5);
  await expect(page.getByRole('combobox', { name: 'Row 5 sensor' })).toHaveValue('network-down');
  await page.getByRole('combobox', { name: 'Row 5 sensor' }).selectOption('cpu-temperature');
  await expect(page.getByRole('textbox', { name: 'Row 5 label', exact: true })).toHaveValue('CPU temp');
  await page.getByRole('button', { name: 'Move CPU temp up', exact: true }).click();
  await page.getByRole('button', { name: 'Remove GPU', exact: true }).click();
  await page.getByRole('textbox', { name: 'Row 1 label', exact: true }).fill('Processor');
  await page.getByRole('textbox', { name: 'Row 1 label', exact: true }).press('Enter');
  await page.getByRole('textbox', { name: 'Row 1 sample value', exact: true }).fill('12345678901234567');
  await page.getByRole('textbox', { name: 'Row 1 sample value', exact: true }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('at most 16 characters');
  await page.getByRole('textbox', { name: 'Row 1 sample value', exact: true }).press('Escape');
  await page.getByLabel('Show bars', { exact: true }).uncheck();
  await expect(list.locator('.sensor-bar')).toHaveCount(0);
  await expect(list.locator('[data-list-row]')).toHaveText([/^Processor/, /^Memory/, /^CPU temp/, /^Disk/]);

  await add(page, 'network history', 'Network history graph');
  const graph = card(page, 'network-graph');
  await expect(graph.locator('[data-graph-series]')).toHaveCount(2);
  await expect(graph.locator('[data-graph-style="area"] polygon').first()).toBeVisible();
  await page.getByRole('radio', { name: 'Line', exact: true }).check();
  await page.getByRole('combobox', { name: 'Second series' }).selectOption('');
  await page.getByRole('combobox', { name: 'First series' }).selectOption('gpu');
  await expect(graph.locator('[data-graph-series]')).toHaveCount(1);
  await expect(graph.locator('polygon')).toHaveCount(0);
  await expect(graph).toContainText('0-100 %');

  await add(page, 'calendar', 'Month calendar');
  const calendar = card(page, 'calendar');
  await expect(calendar.locator('[data-calendar-today]')).toHaveText('6');
  await expect(calendar).toContainText('October');
  await page.getByRole('combobox', { name: 'Week starts on' }).selectOption('sunday');
  await expect(calendar.locator('text').filter({ hasText: /^(Su|Mo)$/ }).first()).toHaveText('Su');
  await page.getByRole('combobox', { name: 'Panel data source' }).selectOption('sample');

  const exported = validateLayout(JSON.parse(await exportJson(page)));
  const [listWidget, graphWidget, calendarWidget] = exported.widgets as [ListWidget, GraphWidget, CalendarWidget];
  expect(listWidget.settings).toEqual({ label: 'System', bars: false, rows: [
    { source: 'cpu', label: 'Processor', value: '29', unit: '%' }, { source: 'memory', label: 'Memory', value: '40', unit: '%' },
    { source: 'cpu-temperature', label: 'CPU temp', value: '44', unit: '°C' }, { source: 'disk', label: 'Disk', value: '45', unit: '%' },
  ] });
  expect(graphWidget.settings).toEqual({ label: 'Network', style: 'line', sources: ['gpu'] });
  expect(calendarWidget.settings).toEqual({ label: 'Calendar', source: 'sample', weekStart: 'sunday' });

  await page.getByLabel('Open layout file', { exact: true }).setInputFiles({ name: 'exported.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await page.getByRole('button', { name: 'Open and discard changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Opened' })).toBeVisible();
  await expect(card(page, 'system-list').locator('[data-list-row]')).toHaveCount(4);
  await expect(card(page, 'network-graph').locator('[data-graph-series="gpu"]')).toHaveCount(1);
  await expect(card(page, 'calendar').locator('[data-calendar-today]')).toHaveText('6');
  expect(validateLayout(JSON.parse(await exportJson(page)))).toEqual(exported);
});
