import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';

async function setup(page: Page) {
  const entries = ['Current dashboard', 'System overview', 'AI usage', 'Focus'].map((name, index) => {
    const document = createSampleLayout();
    document.name = name; document.widgets[0].x = 64 + index * 10;
    return { id: `layout-${index + 1}`, name, document };
  });
  let panel = structuredClone(entries[0].document);
  let revision = 'panel-1';
  let libraryRevision = 'library-1';
  let activeId = entries[0].id;
  const switches: { body: { slot?: number; id?: string; direction?: string }; match: string }[] = [];
  let panelWrites = 0;
  let updates = 0;
  let conflict = false;
  let switchGate: Promise<void> | null = null;
  await page.route('**/api/layout', (route) => {
    if (route.request().method() === 'POST') {
      panelWrites++;
      if (route.request().headers()['if-match'] !== revision) return route.fulfill({ status: 409, json: { error: 'Changed elsewhere', revision } });
    }
    return route.fulfill({ json: { document: panel, revision } });
  });
  await page.route('**/api/layouts', (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().headers()['if-match']).toBe(libraryRevision);
      entries.splice(0, entries.length, ...route.request().postDataJSON().entries);
      libraryRevision = `library-${++updates + 1}`;
    }
    return route.fulfill({ json: { entries, revision: libraryRevision, activeId } });
  });
  await page.route('**/api/layouts/switch', async (route) => {
    const body = route.request().postDataJSON();
    const match = route.request().headers()['if-match'];
    switches.push({ body, match });
    if (conflict) { await route.fulfill({ status: 409, json: { error: 'Changed elsewhere', revision: 'external' } }); return; }
    expect(match).toBe(revision);
    if (switchGate) await switchGate;
    const entry = body.slot ? entries[body.slot - 1] : entries.find((entry) => entry.id === body.id) ?? entries[1];
    panel = structuredClone(entry.document); activeId = entry.id;
    revision = `panel-${switches.length + 1}`;
    await route.fulfill({ json: { document: panel, revision, activeId, archive: { id: 'archived' } } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: revision, appliedRevision: revision } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Test uses HTML preview' } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Library', exact: true })).toBeVisible();
  return { entries, switches, getPanelWrites: () => panelWrites, getUpdates: () => updates,
    getPanel: () => panel,
    setConflict: () => { conflict = true; }, setGate: (gate: Promise<void>) => { switchGate = gate; } };
}

test('saving and reordering a layout rotation never applies the editor draft to the panel', async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel('Layout name').fill('My custom dashboard');
  await page.getByLabel('Layout name').press('Enter');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Library', exact: true });
  await expect(dialog.locator('li')).toHaveCount(4);
  await expect(dialog.getByText('Ctrl + F9', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Ctrl + F12', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Add current draft', exact: true }).click();
  await expect(dialog.locator('li')).toHaveCount(5);
  expect(state.entries[4].document.name).toBe('My custom dashboard');
  await dialog.getByRole('button', { name: 'Move My custom dashboard earlier', exact: true }).click();
  await expect(dialog.locator('li').nth(3)).toContainText('My custom dashboard');
  await expect(dialog.locator('li').nth(3)).toContainText('Ctrl + F12');
  expect(state.getUpdates()).toBe(2);
  expect(state.getPanelWrites()).toBe(0);
  expect(state.switches).toHaveLength(0);
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
});

test('switching a dashboard does not silently rebase the editor draft for saving', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+F10');
  await expect.poll(() => state.switches.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save to panel', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed elsewhere');
  await expect(page.getByLabel('X position')).toHaveValue('65');
  expect(state.getPanel().name).toBe('System overview');
  await expect(page.getByRole('button', { name: 'Review panel changes', exact: true })).toBeVisible();
});

test('Ctrl+F9 through Ctrl+F12 select the four physical panel slots', async ({ page }) => {
  const state = await setup(page);
  for (let slot = 1; slot <= 4; slot++) {
    await page.keyboard.press(`Control+F${slot + 8}`);
    await expect.poll(() => state.switches.length).toBe(slot);
    await expect.poll(() => state.getPanel().name).toBe(state.entries[slot - 1].name);
    await expect(page.locator('.app-footer [role="status"]')).toContainText(`Switched panel to ${state.entries[slot - 1].name}.`);
    await expect(page.getByLabel('Layout name')).toHaveValue('Current dashboard');
    expect(state.switches[slot - 1].body).toEqual({ slot });
    expect(state.switches[slot - 1].match).toBe(`panel-${slot}`);
  }
  expect(state.getPanelWrites()).toBe(0);
});

test('switching preserves edits made before and during the request and blocks concurrent panel operations', async ({ page }) => {
  const state = await setup(page);
  let release!: () => void;
  state.setGate(new Promise<void>((resolve) => { release = resolve; }));
  const card = page.getByRole('group', { name: 'CPU load card' });
  await card.focus(); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+F11');
  await expect.poll(() => state.switches.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open panel dashboard', exact: true })).toBeDisabled();
  await page.keyboard.press('Control+F12');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('X position')).toHaveValue('66');
  release();
  await expect(page.getByRole('button', { name: 'Save to panel', exact: true })).toBeEnabled();
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
  await expect(page.getByLabel('X position')).toHaveValue('66');
  await expect(page.getByLabel('Layout name')).toHaveValue('Current dashboard');
  await expect(page.getByRole('status').filter({ hasText: 'Your editor draft is unchanged' })).toBeVisible();
  expect(state.switches).toHaveLength(1);
});

test('a stale panel revision preserves the draft and stays protected on retry', async ({ page }) => {
  const state = await setup(page); state.setConflict();
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+F10');
  await expect(page.getByRole('alert')).toContainText('changed elsewhere');
  await expect(page.getByLabel('X position')).toHaveValue('65');
  await page.keyboard.press('Control+F12');
  await expect.poll(() => state.switches.length).toBe(2);
  expect(state.switches.map((attempt) => attempt.match)).toEqual(['panel-1', 'panel-1']);
  await expect(page.getByLabel('Layout name')).toHaveValue('Current dashboard');
});

test('a panel shortcut retains uncommitted input text as well as committed edits', async ({ page }) => {
  const state = await setup(page);
  const name = page.getByLabel('Layout name');
  await name.fill('Still typing this dashboard name');
  await name.press('Control+F10');
  await expect.poll(() => state.getPanel().name).toBe('System overview');
  await expect(name).toHaveValue('Still typing this dashboard name');
  await name.press('Enter');
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
});

test('inspector input typed during a delayed switch remains until the user commits it', async ({ page }) => {
  const state = await setup(page);
  let release!: () => void;
  state.setGate(new Promise<void>((resolve) => { release = resolve; }));
  await page.keyboard.press('Control+F12');
  await expect.poll(() => state.switches.length).toBe(1);
  const x = page.getByLabel('X position');
  await x.fill('75');
  release();
  await expect.poll(() => state.getPanel().name).toBe('Focus');
  await expect(x).toHaveValue('75');
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  await x.press('Enter');
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
});
