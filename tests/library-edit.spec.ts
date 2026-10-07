import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';

async function fixture(page: Page) {
  const panel = createSampleLayout();
  const document = createSampleLayout(); document.name = 'Focus'; document.widgets[0].x = 110;
  const entries = [{ id: 'focus', name: 'Focus', document }];
  let revision = 'library-1';
  let panelWrites = 0;
  const matches: string[] = [];
  await page.route('**/api/layout', (route) => {
    if (route.request().method() === 'POST') panelWrites++;
    return route.fulfill({ json: { document: panel, revision: 'panel-1' } });
  });
  await page.route('**/api/layouts', (route) => {
    if (route.request().method() === 'POST') {
      const match = route.request().headers()['if-match']; matches.push(match);
      if (match !== revision) return route.fulfill({ status: 409, json: { error: 'Library changed', revision } });
      entries.splice(0, entries.length, ...route.request().postDataJSON().entries);
      revision = 'library-2';
    }
    return route.fulfill({ json: { entries, revision, activeId: null } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'panel-1', appliedRevision: 'panel-1' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Fixture uses local preview' } }));
  await page.goto('/');
  return { entries, matches, getPanelWrites: () => panelWrites, changeLibrary(next = 'external-library') { revision = next; entries[0].document.widgets[0].x = 150; } };
}

test('edit and save a library entry without applying a dashboard', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('dialog', { name: 'Library', exact: true }).getByRole('button', { name: 'Edit as draft', exact: true }).click();
  await expect(page.getByLabel('Layout name')).toHaveValue('Focus');
  await expect(page.getByLabel('X position')).toHaveValue('110');
  await page.getByLabel('X position').fill('125'); await page.getByLabel('X position').press('Enter');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect.poll(() => state.entries[0].document.widgets[0].x).toBe(125);
  expect(state.matches).toEqual(['library-1']);
  expect(state.getPanelWrites()).toBe(0);
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
});

test('a library conflict keeps the draft and the other saved version', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('dialog', { name: 'Library', exact: true }).getByRole('button', { name: 'Edit as draft', exact: true }).click();
  await page.getByLabel('X position').fill('125'); await page.getByLabel('X position').press('Enter');
  state.changeLibrary();
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Library changed', exact: true })).toBeVisible();
  expect(state.entries[0].document.widgets[0].x).toBe(150);
  expect(state.getPanelWrites()).toBe(0);
  await expect(page.getByLabel('X position')).toHaveValue('125');
});

test('library draft recovery retains its save target and original library revision', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('dialog', { name: 'Library', exact: true }).getByRole('button', { name: 'Edit as draft', exact: true }).click();
  await page.getByLabel('X position').fill('125'); await page.getByLabel('X position').press('Enter');
  await expect(page.getByText('Draft backed up', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover a draft' }).getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save to library', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect.poll(() => state.entries[0].document.widgets[0].x).toBe(125);
  expect(state.matches).toEqual(['library-1']);
  expect(state.getPanelWrites()).toBe(0);
});


test('duplicate and rename change only the library, and removal requires confirmation', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Library', exact: true });
  await library.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect.poll(() => state.entries.length).toBe(2);
  expect(state.entries[1].document.name).toBe('Focus copy');
  await library.locator('li').last().getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Library name', { exact: true }).fill('New label');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect.poll(() => state.entries[1].name).toBe('New label');
  expect(state.entries[1].document.name).toBe('Focus copy');
  await library.getByRole('button', { name: 'Remove New label from library', exact: true }).click();
  expect(state.entries).toHaveLength(2);
  await page.getByRole('dialog', { name: 'Remove from library' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.entries).toHaveLength(2);
  await library.getByRole('button', { name: 'Remove New label from library', exact: true }).click();
  await page.getByRole('dialog', { name: 'Remove from library' }).getByRole('button', { name: 'Remove from library', exact: true }).click();
  await expect.poll(() => state.entries.length).toBe(1);
  expect(state.getPanelWrites()).toBe(0);
});

test('confirming a library conflict uses the displayed revision and preserves newer edits', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('dialog', { name: 'Library', exact: true }).getByRole('button', { name: 'Edit as draft', exact: true }).click();
  await page.getByLabel('X position').fill('125'); await page.getByLabel('X position').press('Enter');
  state.changeLibrary();
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Library changed', exact: true });
  await expect(dialog).toBeVisible();
  state.changeLibrary('second-external');
  await dialog.getByRole('button', { name: 'Replace library entry with draft', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Library changed');
  expect(state.entries[0].document.widgets[0].x).toBe(150);
  await dialog.getByRole('button', { name: 'Save as new entry', exact: true }).click();
  await expect.poll(() => state.entries.length).toBe(2);
  expect(state.entries[0].document.widgets[0].x).toBe(150);
  expect(state.entries[1].document.widgets[0].x).toBe(125);
  expect(state.matches).toEqual(['external-library', 'second-external']);
  expect(state.getPanelWrites()).toBe(0);
});


test('renaming a changed library entry does not adopt its new content as the draft base', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Library', exact: true });
  await library.getByRole('button', { name: 'Edit as draft', exact: true }).click();
  await page.getByLabel('X position').fill('125'); await page.getByLabel('X position').press('Enter');
  state.changeLibrary();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await library.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Library name', { exact: true }).fill('Renamed Focus');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect.poll(() => state.entries[0].name).toBe('Renamed Focus');
  await library.getByRole('button', { name: 'Close library', exact: true }).click();
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Library changed', exact: true })).toBeVisible();
  expect(state.entries[0].document.widgets[0].x).toBe(150);
});

test('a delayed library save cannot attach its target to another opened draft', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('dialog', { name: 'Library', exact: true }).getByRole('button', { name: 'Edit as draft', exact: true }).click();
  await page.getByLabel('X position').fill('125'); await page.getByLabel('X position').press('Enter');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let saving = false;
  await page.route('**/api/layouts', async (route) => {
    if (route.request().method() === 'POST') { saving = true; await gate; }
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect.poll(() => saving).toBe(true);
  await page.getByRole('button', { name: 'Open panel dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Open and discard changes', exact: true }).click();
  await expect(page.getByLabel('Layout name')).toHaveValue(createSampleLayout().name);
  release();
  await expect.poll(() => state.entries[0].document.widgets[0].x).toBe(125);
  await expect(page.getByRole('button', { name: 'Save to library', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  expect(state.matches).toHaveLength(1);
});
