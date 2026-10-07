import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';
import { readFile } from 'node:fs/promises';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1WQAAAAASUVORK5CYII=', 'base64');

test('trend templates show explicit demo charts and export independent source settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const catalog = page.getByRole('dialog', { name: 'Add widget', exact: true });
  await catalog.getByLabel('Search widgets', { exact: true }).fill('CPU load trend');
  await catalog.getByRole('button', { name: 'Add CPU load trend', exact: true }).click();
  const trend = page.locator('[data-widget-id="cpu-trend"]');
  await expect(trend.locator('[data-trend="true"]')).toBeVisible();
  await expect(trend).toContainText('Last 120 readings · Demo');
  await page.getByLabel('Panel data source', { exact: true }).selectOption('network-down');
  await expect(trend.getByRole('img')).toHaveAttribute('aria-label', /KB\/s/);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const downloaded = await pending;
  const saved = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
  expect(saved.widgets.find((widget: { id: string }) => widget.id === 'cpu-trend').settings).toMatchObject({ source: 'network-down', trend: true });
});

async function api(page: Page) {
  const document = createSampleLayout();
  let writes = 0;
  await page.route('**/api/layout', (route) => {
    if (route.request().method() === 'POST') writes++;
    return route.fulfill({ json: { document, revision: 'saved-panel' } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'saved-panel', appliedRevision: 'saved-panel' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  return { document, writes: () => writes };
}

test('live preview refreshes draft readings without applying or changing document history', async ({ page }) => {
  const state = await api(page);
  const previews: { live: boolean; document: typeof state.document }[] = [];
  await page.route(/\/api\/preview(?:\?.*)?$/, (route) => {
    previews.push({ live: new URL(route.request().url()).searchParams.get('mode') === 'live', document: route.request().postDataJSON() });
    return route.fulfill({ body: png, contentType: 'image/png' });
  });
  await page.goto('/');
  await expect(page.getByText('Panel renderer · Sample values', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByText('Panel renderer · Live readings', { exact: true })).toBeVisible();
  await expect.poll(() => previews.filter((preview) => preview.live).length).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(state.writes()).toBe(0);
  await page.getByRole('group', { name: 'CPU load card', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => previews.at(-1)?.document.widgets[0].x).toBe(state.document.widgets[0].x + 1);
  expect(state.writes()).toBe(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
});

test('diagnostics distinguish unavailable sensors and cached quotas with observation times', async ({ page }) => {
  await api(page);
  await page.route(/\/api\/preview(?:\?.*)?$/, (route) => route.fulfill({ body: png, contentType: 'image/png' }));
  await page.route('**/api/live', (route) => route.fulfill({ json: { available: true, sources: [
    { id: 'cpu', label: 'CPU load', value: 42, unit: '%', status: 'ok', observedAt: 1791320000, samples: 12 },
    { id: 'gpu', label: 'GPU load', value: null, unit: '%', status: 'unavailable', observedAt: 1791320000, samples: 0 },
  ] } }));
  await page.route('**/api/usage', (route) => route.fulfill({ json: { providers: {
    codex: { total: 1000, limits: [{ label: 'Weekly', usedPercent: 54, stale: false }], freshness: { tokens: { status: 'cached' }, limits: { observedAt: '2026-10-06T23:00:00Z' } } },
    claude: { total: null, limits: [], freshness: { limits: { observedAt: null } } },
  } } }));
  await page.goto('/');
  await page.getByText('Data sources', { exact: true }).click();
  const cpu = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'CPU load', exact: true }) });
  await expect(cpu).toContainText('42 %');
  await expect(cpu).toContainText('ok · 12 readings');
  await expect(page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'GPU load', exact: true }) })).toContainText('Unknown');
  const quota = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Codex Pro quota', exact: true }) });
  await expect(quota).toContainText('54% observed');
  await expect(quota).not.toContainText('Unknown');
  await page.screenshot({ path: 'artifacts/m5-source-diagnostics-browser.png', fullPage: true });
});

test('stale live readings fall back to labelled sample and switching modes discards delayed frames', async ({ page }) => {
  const state = await api(page);
  let liveRequests = 0, release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/preview(?:\?.*)?$/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('mode') === 'live') {
      liveRequests++;
      if (liveRequests === 1) return route.fulfill({ status: 503, json: { error: 'Live readings are stale.' } });
      await gate;
    }
    await route.fulfill({ body: png, contentType: 'image/png' }).catch(() => {});
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByText(/Live readings are stale.*Showing the local sample preview/)).toBeVisible();
  await page.getByRole('button', { name: 'Retry preview', exact: true }).click();
  await expect.poll(() => liveRequests).toBe(2);
  await page.getByRole('button', { name: 'Sample', exact: true }).click();
  release!();
  await expect(page.getByText('Panel renderer · Sample values', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sample', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  expect(state.writes()).toBe(0);
});
