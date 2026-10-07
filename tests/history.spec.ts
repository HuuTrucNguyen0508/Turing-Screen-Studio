import { expect, test } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';

test('history groups duplicate archives and opens a copy without applying it', async ({ page }) => {
  const document = createSampleLayout(); document.name = 'Older dashboard'; document.widgets[0].x = 90;
  let writes = 0;
  await page.route('**/api/layout', (route) => {
    if (route.request().method() === 'POST') writes++;
    return route.fulfill({ json: { document: createSampleLayout(), revision: 'panel' } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'panel', appliedRevision: 'panel' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Local preview' } }));
  await page.route('**/api/history', (route) => route.fulfill({ json: { archives: ['archive-a', 'archive-b'].map((id) => ({ id, name: document.name, revision: 'same', createdAt: '2026-10-06T20:00:00Z', reason: 'panel-save' })) } }));
  await page.route('**/api/history/*', (route) => route.fulfill({ json: { document, revision: 'same' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'History', exact: true });
  await expect(history.getByText('2 copies', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Open as draft', exact: true }).click();
  await expect(page.getByLabel('Layout name')).toHaveValue('Older dashboard');
  await expect(page.getByLabel('X position')).toHaveValue('90');
  expect(writes).toBe(0);
});


test('an unreadable archive stays listed and cannot replace the current draft', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/layout', (route) => { if (route.request().method() === 'POST') writes++; return route.fulfill({ json: { document: createSampleLayout(), revision: 'panel' } }); });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Local preview' } }));
  await page.route('**/api/layouts', (route) => route.fulfill({ json: { entries: [], revision: 'library', activeId: null } }));
  await page.route('**/api/history', (route) => route.fulfill({ json: { archives: [{ id: 'damaged', name: 'Damaged copy', revision: 'bad', createdAt: '2026-10-06T20:00:00Z', reason: 'panel-save' }] } }));
  await page.route('**/api/history/*', (route) => route.fulfill({ status: 422, json: { error: 'Archive failed checksum' } }));
  await page.goto('/');
  const original = await page.getByLabel('Layout name').inputValue();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'History', exact: true });
  await expect(history.getByRole('alert')).toContainText('failed its checksum');
  await expect(history.getByText('Damaged copy', { exact: true })).toBeVisible();
  await expect(history.getByRole('button', { name: 'Open as draft', exact: true })).toBeDisabled();
  await history.getByRole('button', { name: 'Close History', exact: true }).click();
  await expect(page.getByLabel('Layout name')).toHaveValue(original);
  expect(writes).toBe(0);
});
