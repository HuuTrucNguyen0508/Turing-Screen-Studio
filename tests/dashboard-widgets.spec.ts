import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';

async function connected(page: Page, conflict = false) {
  let revision = 'a'.repeat(64);
  let writes = 0;
  const requests: { game: string; count?: number; clear?: boolean }[] = [];
  const rows = ['genshin', 'wuwa', 'zzz'].map((id, index) => ({ id, current: null as number | null,
    capacity: index === 0 ? 200 : 240, observedAt: null as string | null, status: 'not-configured', note: 'Not set.' }));
  await page.route('**/api/layout', route => {
    if (route.request().method() === 'POST') writes++;
    return route.fulfill({ json: { document: createSampleLayout(), revision: 'panel' } });
  });
  await page.route('**/api/status', route => route.fulfill({ json: { runtimeRunning: true, connected: true } }));
  await page.route('**/api/palette', route => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/games', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      requests.push(body);
      expect(route.request().headers()['if-match']).toBe(revision);
      if (conflict) return route.fulfill({ status: 409, json: { error: 'Game timers changed elsewhere.' } });
      const row = rows.find(row => row.id === body.game)!;
      row.current = body.clear ? null : body.count;
      row.observedAt = body.clear ? null : '2026-10-07T10:00:00Z';
      row.status = body.clear ? 'not-configured' : 'estimate';
      revision = revision === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    }
    return route.fulfill({ json: { games: rows, revision } });
  });
  await page.goto('/');
  await expect(page.getByText('Panel editor', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Game timers', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Game timers', exact: true });
  await expect(dialog.getByLabel('Original Resin count')).toBeEnabled();
  return { dialog, requests, writes: () => writes };
}

test('shared timers save zero, preserve another typed count and clear without applying a layout', async ({ page }) => {
  const state = await connected(page);
  await state.dialog.getByLabel('Waveplates count').fill('37');
  await state.dialog.getByLabel('Original Resin count').fill('0');
  await state.dialog.getByLabel('Original Resin count').press('Enter');
  await expect(state.dialog.getByText('Saved. Timer starts from this count now.')).toBeVisible();
  await expect(state.dialog.getByLabel('Original Resin count')).toHaveValue('0');
  await expect(state.dialog.getByLabel('Original Resin count')).toBeFocused();
  await expect(state.dialog.getByLabel('Waveplates count')).toHaveValue('37');
  await state.dialog.locator('.timer-row').first().getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(state.dialog.getByText('Cleared. Not set.')).toBeVisible();
  await expect(state.dialog.getByLabel('Original Resin count')).toHaveValue('');
  expect(state.requests).toEqual([{ game: 'genshin', count: 0 }, { game: 'genshin', clear: true }]);
  expect(state.writes()).toBe(0);
});

test('conflicting edits retain typed counts and require an explicit reload', async ({ page }) => {
  const { dialog, requests } = await connected(page, true);
  await dialog.getByLabel('Original Resin count').fill('101');
  const save = dialog.locator('.timer-row').first().getByRole('button', { name: 'Save count', exact: true });
  await save.click();
  await expect(dialog.getByRole('alert')).toHaveText('Game timers changed elsewhere.');
  await expect(dialog.getByLabel('Original Resin count')).toHaveValue('101');
  await save.click();
  await expect(dialog.getByText('Reload timers before trying again. Your typed counts are kept until you reload.')).toBeVisible();
  expect(requests).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Reload timers', exact: true }).click();
  await expect(dialog.getByLabel('Original Resin count')).toHaveValue('');
});

test('mobile timer dialog validates counts and fits the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const { dialog, requests } = await connected(page);
  await dialog.getByLabel('Original Resin count').fill('1.5');
  await dialog.getByLabel('Original Resin count').press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('Enter a whole number from 0 to 10000.');
  expect(requests).toHaveLength(0);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('an unreadable save response keeps the count and explains how to recover', async ({ page }) => {
  const { dialog } = await connected(page);
  await page.route('**/api/games', route => route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad gateway</h1>' }));
  await dialog.getByLabel('Original Resin count').fill('123');
  await dialog.getByLabel('Original Resin count').press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('Studio returned unreadable timer data. Reload timers before trying again.');
  await expect(dialog.getByLabel('Original Resin count')).toHaveValue('123');
  await expect(dialog.getByLabel('Original Resin count')).toBeFocused();
});

test('a future saved timer explains the problem and can be cleared', async ({ page }) => {
  const { dialog } = await connected(page);
  await page.route('**/api/games', route => {
    if (route.request().method() === 'POST') return route.fallback();
    return route.fulfill({ json: { revision: 'a'.repeat(64), games: ['genshin', 'wuwa', 'zzz'].map((id, index) => ({
      id, current: null, capacity: index ? 240 : 200, observedAt: index ? null : '2099-01-01T00:00:00Z',
      status: index ? 'not-configured' : 'unavailable', note: index ? 'Not set.' : 'Check timer: set time is ahead.',
    })) } });
  });
  await dialog.getByRole('button', { name: 'Reload timers', exact: true }).click();
  await expect(dialog.getByText('Check timer: set time is ahead.')).toBeVisible();
  await dialog.locator('.timer-row').first().getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(dialog.getByText('Cleared. Not set.')).toBeVisible();
});

test('offline timer controls explain the shared server and samples remain in the draft', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Game timers', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Game timers', exact: true });
  await expect(dialog.getByText("Open Studio's local server to set shared timers. Offline previews show sample counts.")).toBeVisible();
  await expect(dialog.getByLabel('Original Resin count')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const document = JSON.parse(await readFile('layouts/system-overview-clean.json', 'utf8'));
  await page.getByLabel('Open layout file', { exact: true }).setInputFiles({
    name: 'games.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)),
  });
  const card = page.getByTestId('document-canvas').locator('[data-dashboard-source="game-resources"]');
  await expect(card).toContainText('Sample');
  await expect(card.locator('[data-game-row]')).toHaveCount(3);
  await expect(card).toContainText('137');
  await expect(card).toContainText('Set in Game timers');
});
