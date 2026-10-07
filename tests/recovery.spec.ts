import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';

async function panelFixture(page: Page) {
  let saved = createSampleLayout();
  let revision = 'initial';
  const writes: string[] = [];
  await page.route('**/api/layout', async (route) => {
    if (route.request().method() === 'POST') {
      const match = route.request().headers()['if-match'];
      writes.push(match);
      if (match !== revision) {
        await route.fulfill({ status: 409, json: { error: 'Changed elsewhere', revision } });
        return;
      }
      saved = route.request().postDataJSON();
      revision = `saved-${writes.length}`;
    }
    await route.fulfill({ json: { document: saved, revision } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: {
    runtimeRunning: true, connected: true, requestedRevision: revision, appliedRevision: revision,
  } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Preview unavailable in fixture' } }));
  return { writes, externalChange(next = 'external') { saved.widgets[0].x = 120; revision = next; }, getSaved: () => saved };
}

test('undo and redo restore committed edits and the clean baseline', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('group', { name: 'CPU load card' });
  await card.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('X position')).toHaveValue('65');
  await page.getByLabel('Label', { exact: true }).fill('My CPU');
  await page.getByLabel('Label', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('CPU load');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('X position')).toHaveValue('64');
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByLabel('X position')).toHaveValue('65');
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
});

test('a drag is one undo step and cancelling a drag adds none', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('group', { name: 'CPU load card' });
  const bounds = await card.boundingBox();
  if (!bounds) throw new Error('Card missing');
  await page.mouse.move(bounds.x + 40, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 90, bounds.y + 60, { steps: 12 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('X position')).toHaveValue('64');
  await expect(page.getByLabel('Y position')).toHaveValue('160');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.mouse.move(bounds.x + 40, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 80, bounds.y + 50);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByLabel('X position')).toHaveValue('64');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('reload offers a committed draft without applying it or losing its original revision', async ({ page }) => {
  const state = await panelFixture(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeEnabled();
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Draft backed up', { exact: true })).toBeVisible();
  state.externalChange();
  await page.reload();
  const recovery = page.getByRole('dialog', { name: 'Recover a draft' });
  await expect(recovery).toBeVisible();
  await recovery.getByRole('button', { name: 'Restore draft', exact: true }).first().click();
  await expect(page.getByLabel('X position')).toHaveValue('65');
  expect(state.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Save to panel', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'changed elsewhere' })).toBeVisible();
  expect(state.writes).toEqual(['initial']);
  expect(state.getSaved().widgets[0].x).toBe(120);
});

test('viewing the active panel and explicitly replacing it retains the draft and checks the fresh revision', async ({ page }) => {
  const state = await panelFixture(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeEnabled();
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  state.externalChange();
  await page.getByRole('button', { name: 'Save to panel', exact: true }).click();
  await page.getByRole('button', { name: 'Review panel changes', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Panel changed' });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('X position')).toHaveValue('65');
  await dialog.getByRole('button', { name: 'Replace panel with draft', exact: true }).click();
  await expect.poll(() => state.writes).toEqual(['initial', 'external']);
  expect(state.getSaved().widgets[0].x).toBe(65);
});

test('a server appearing after startup is detected without reloading or discarding edits', async ({ page }) => {
  let online = false;
  let writes = 0;
  await page.route('**/api/layout', (route) => {
    if (route.request().method() === 'POST') writes++;
    return online ? route.fulfill({ json: { document: createSampleLayout(), revision: 'online' } })
      : route.fulfill({ status: 503, json: { error: 'Offline' } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'online', appliedRevision: 'online' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Unavailable' } }));
  await page.goto('/');
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  online = true;
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('X position')).toHaveValue('65');
  expect(writes).toBe(0);
});

test('replacement rejects a second external change after the comparison was opened', async ({ page }) => {
  const state = await panelFixture(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeEnabled();
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  state.externalChange();
  await page.getByRole('button', { name: 'Save to panel', exact: true }).click();
  await page.getByRole('button', { name: 'Review panel changes', exact: true }).click();
  state.externalChange('changed-again');
  await page.getByRole('dialog', { name: 'Panel changed' }).getByRole('button', { name: 'Replace panel with draft', exact: true }).click();
  await expect.poll(() => state.writes).toEqual(['initial', 'external']);
  expect(state.getSaved().widgets[0].x).toBe(120);
  await expect(page.getByLabel('X position')).toHaveValue('65');
});

test('two tabs keep distinct draft backups', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Draft backed up', { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByRole('dialog', { name: 'Recover a draft' })).not.toBeVisible();
  await other.getByRole('group', { name: 'CPU load card' }).focus();
  await other.keyboard.press('Shift+ArrowRight');
  await expect(other.getByText('Draft backed up', { exact: true })).toBeVisible();
  const records = await page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith('turzx-studio:recovery:v1:')).map((key) => JSON.parse(localStorage.getItem(key)!)));
  expect(records).toHaveLength(2);
  expect(new Set(records.map((record) => record.recordId)).size).toBe(2);
  expect(records.map((record) => record.document.widgets[0].x).sort((a, b) => a - b)).toEqual([65, 74]);
  await other.close();
});

test('failed backup keeps the last good draft and leaves editing usable', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('group', { name: 'CPU load card' });
  await card.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Draft backed up', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('turzx-studio:recovery:v1:')) throw new DOMException('Storage full', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  await card.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('alert')).toContainText('Draft backup failed');
  await expect(page.getByLabel('X position')).toHaveValue('66');
  const backedUp = await page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith('turzx-studio:recovery:v1:')).map((key) => JSON.parse(localStorage.getItem(key)!)));
  expect(backedUp[0].document.widgets[0].x).toBe(65);
});

test('starting an unfinished drag backs up the preceding committed edit', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('group', { name: 'CPU load card' });
  await card.focus(); await page.keyboard.press('ArrowRight');
  const bounds = await card.boundingBox();
  if (!bounds) throw new Error('Card missing');
  await page.mouse.move(bounds.x + 35, bounds.y + 35);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 80, bounds.y + 35);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith('turzx-studio:recovery:v1:'))
    .map((key) => JSON.parse(localStorage.getItem(key)!).document.widgets[0].x))).toEqual([65]);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.getByLabel('X position')).toHaveValue('65');
});

test('dismissing startup recovery opens the deferred panel dashboard', async ({ page }) => {
  const state = await panelFixture(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeEnabled();
  await page.getByRole('group', { name: 'CPU load card' }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Draft backed up', { exact: true })).toBeVisible();
  state.externalChange();
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover a draft' }).getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('X position')).toHaveValue('120');
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(0);
});

test('restoring another draft preserves the current unfinished draft as a separate backup', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('group', { name: 'CPU load card' }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Draft backed up', { exact: true })).toBeVisible();
  const other = await context.newPage(); await other.goto('/');
  await other.getByRole('group', { name: 'CPU load card' }).focus(); await other.keyboard.press('Shift+ArrowRight');
  await expect(other.getByText('Draft backed up', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recover drafts', exact: true }).click();
  await page.getByRole('dialog', { name: 'Recover a draft' }).getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(page.getByLabel('X position')).toHaveValue('74');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith('turzx-studio:recovery:v1:')).map((key) => JSON.parse(localStorage.getItem(key)!).document.widgets[0].x))).toContain(65);
  await other.close();
});

test('a live tab rewrites its backup if another tab removes it', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('group', { name: 'CPU load card' }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Draft backed up', { exact: true })).toBeVisible();
  const other = await context.newPage(); await other.goto('/');
  await other.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('turzx-studio:recovery:v1:')).forEach((key) => localStorage.removeItem(key)));
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith('turzx-studio:recovery:v1:')).map((key) => JSON.parse(localStorage.getItem(key)!).document.widgets[0].x))).toEqual([65]);
  await other.close();
});


test('owner polling does not reopen recovery and restoring rereads the latest stored draft', async ({ page, context }) => {
  await page.goto('/');
  const card = page.getByRole('group', { name: 'CPU load card' });
  await card.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Draft backed up', { exact: true })).toBeVisible();
  const other = await context.newPage(); await other.goto('/');
  await expect(other.getByRole('dialog', { name: 'Recover a draft' })).not.toBeVisible();
  await other.getByRole('button', { name: 'Recover drafts', exact: true }).click();
  await card.focus(); await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByText('Draft backed up', { exact: true })).toBeVisible();
  await other.getByRole('dialog', { name: 'Recover a draft' }).getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(other.getByLabel('X position')).toHaveValue('75');
  await page.close();
  // Trigger another owner query without a 5-second wait. It must not reopen the dialog.
  await other.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'owner-change' })));
  await expect(other.getByRole('dialog', { name: 'Recover a draft' })).not.toBeVisible();
  const records = await other.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('turzx-studio:recovery:v1:')).map((key) => JSON.parse(localStorage.getItem(key)!)));
  expect(records.some((record) => record.document.widgets[0].x === 75)).toBe(true);
});
