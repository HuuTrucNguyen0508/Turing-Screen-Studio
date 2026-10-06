import { expect, test } from '@playwright/test';
import { createSampleLayout } from '../src/domain/layout';

test('drag, save, and wait for the exact panel revision without losing newer edits', async ({ page }) => {
  const layout = createSampleLayout();
  let saved = structuredClone(layout);
  let requested = 'first';
  let applied = 'first';
  let releaseSave: (() => void) | undefined;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route('**/api/layout', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().headers()['if-match']).toBe('first');
      saved = route.request().postDataJSON();
      requested = 'second';
      await saveGate;
    }
    await route.fulfill({ json: { document: saved, revision: requested } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, view: 'stats', requestedRevision: requested, appliedRevision: applied } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Test uses HTML preview' } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save to panel' })).toBeVisible();
  const card = page.getByRole('group', { name: 'CPU load card' });
  const bounds = await card.boundingBox();
  if (!bounds) throw new Error('Card missing');
  await page.mouse.move(bounds.x + 40, bounds.y + 50);
  await page.mouse.down(); await page.mouse.move(bounds.x + 60, bounds.y + 50); await page.mouse.up();
  await page.getByRole('button', { name: 'Save to panel' }).click();
  await expect.poll(() => saved.widgets[0].x).toBeGreaterThan(layout.widgets[0].x);
  await expect(page.getByRole('button', { name: 'Open saved layout' })).toBeDisabled();
  await card.focus(); await page.keyboard.press('ArrowRight');
  releaseSave!();
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
  await expect(page.getByText('Waiting for panel', { exact: true })).toBeVisible();
  applied = 'second';
  await expect(page.getByText('Panel accepted frame', { exact: true })).toBeVisible();
  await expect(page.getByLabel('X position')).toHaveValue(String(saved.widgets[0].x + 1));
});

test('editing before the initial saved layout loads requires a confirmed open before saving', async ({ page }) => {
  const saved = createSampleLayout();
  saved.widgets[0].x = 100;
  let releaseLoad: (() => void) | undefined;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  let posted = false;
  await page.route('**/api/layout', async (route) => {
    if (route.request().method() === 'POST') posted = true;
    await loadGate;
    await route.fulfill({ json: { document: saved, revision: 'saved' } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'saved', appliedRevision: 'saved' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Test uses HTML preview' } }));
  await page.goto('/');
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  releaseLoad!();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByLabel('X position')).toHaveValue('65');
  await expect(page.getByRole('button', { name: 'Save to panel' })).toBeDisabled();
  await expect(page.getByText('Export your draft, then open the saved layout', { exact: false })).toBeVisible();
  expect(posted).toBe(false);
  await page.getByRole('button', { name: 'Open saved layout' }).click();
  await page.getByRole('button', { name: 'Open and discard changes' }).click();
  await expect(page.getByLabel('X position')).toHaveValue('100');
  await expect(page.getByRole('button', { name: 'Save to panel' })).toBeEnabled();
});

test('opening the saved layout prevents a concurrent save', async ({ page }) => {
  let gets = 0;
  let releaseOpen: (() => void) | undefined;
  const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  await page.route('**/api/layout', async (route) => {
    if (++gets > 1) await openGate;
    await route.fulfill({ json: { document: createSampleLayout(), revision: 'saved' } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'saved', appliedRevision: 'saved' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Test uses HTML preview' } }));
  await page.goto('/');
  const save = page.getByRole('button', { name: 'Save to panel' });
  await expect(save).toBeEnabled();
  await page.getByRole('button', { name: 'Open saved layout' }).click();
  await expect.poll(() => gets).toBe(2);
  await expect(save).toBeDisabled();
  releaseOpen!();
  await expect(save).toBeEnabled();
});

test('conflicts stay protected until the saved layout is actually opened', async ({ page }) => {
  let saved = createSampleLayout();
  let revision = 'first';
  const attempts: string[] = [];
  await page.route('**/api/layout', async (route) => {
    if (route.request().method() === 'POST') {
      const expected = route.request().headers()['if-match'];
      attempts.push(expected);
      if (expected !== revision) {
        await route.fulfill({ status: 409, json: { error: 'Changed elsewhere', revision } });
        return;
      }
      saved = route.request().postDataJSON();
      revision = 'third';
    }
    await route.fulfill({ json: { document: saved, revision } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: revision, appliedRevision: revision } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Test uses HTML preview' } }));
  await page.goto('/');
  const save = page.getByRole('button', { name: 'Save to panel' });
  await expect(save).toBeVisible();
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  saved.widgets[0].x = 100;
  revision = 'second';
  await save.click();
  await expect(page.getByRole('alert')).toContainText('changed elsewhere');
  await expect(page.getByLabel('X position')).toHaveValue('65');
  await page.getByRole('button', { name: 'Open saved layout' }).click();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await save.click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts).toEqual(['first', 'first']);
  expect(saved.widgets[0].x).toBe(100);
  await page.getByRole('button', { name: 'Open saved layout' }).click();
  await page.getByRole('button', { name: 'Open and discard changes' }).click();
  await expect(page.getByLabel('X position')).toHaveValue('100');
  await save.click();
  await expect.poll(() => attempts.length).toBe(3);
  expect(attempts[2]).toBe('second');
});

test('an outdated runtime explains the blocked save and preserves the draft and revision', async ({ page }) => {
  const saved = createSampleLayout();
  const attempts: string[] = [];
  const runtimeError = 'The panel runtime needs an update before saving these widgets. Restart turzx-dashboard.service with the current Studio adapter; your draft and saved layout are intact.';
  await page.route('**/api/layout', async (route) => {
    if (route.request().method() === 'POST') {
      attempts.push(route.request().headers()['if-match']);
      expect(route.request().postDataJSON().widgets.some((widget: { type: string }) => widget.type === 'clock')).toBe(true);
      await route.fulfill({ status: 409, json: { error: runtimeError } });
    } else await route.fulfill({ json: { document: saved, revision: 'saved' } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'saved', appliedRevision: 'saved' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Test uses HTML preview' } }));
  await page.goto('/');
  const save = page.getByRole('button', { name: 'Save to panel' });
  await expect(save).toBeEnabled();
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  await page.getByRole('button', { name: 'Add Clock', exact: true }).click();
  await save.click();
  await expect(page.getByRole('alert')).toContainText(runtimeError);
  await expect(page.getByRole('alert')).not.toContainText('changed elsewhere');
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
  await expect(page.getByLabel('Time', { exact: true })).toHaveValue('14:32');
  await save.click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts).toEqual(['saved', 'saved']);
});

test('missing acknowledgements and pre-save status responses cannot report acceptance', async ({ page }) => {
  let revision = 'first';
  let pollCount = 0;
  let releasePoll: (() => void) | undefined;
  const pollGate = new Promise<void>((resolve) => { releasePoll = resolve; });
  await page.route('**/api/layout', async (route) => {
    if (route.request().method() === 'POST') revision = 'second';
    await route.fulfill({ json: { document: createSampleLayout(), revision } });
  });
  await page.route('**/api/status', async (route) => {
    const count = ++pollCount;
    if (count === 1) {
      await route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: null, appliedRevision: null } });
      return;
    }
    const requestedRevision = revision;
    if (count === 2) await pollGate;
    await route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision, appliedRevision: 'first' } });
  });
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Test uses HTML preview' } }));
  await page.goto('/');
  await expect(page.getByText('Waiting for panel', { exact: true })).toBeVisible();
  await expect.poll(() => pollCount).toBe(2);
  await page.getByRole('group', { name: 'CPU load card' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Save to panel' }).click();
  await expect(page.getByTestId('document-status')).toHaveText('No unsaved changes');
  const staleResponse = page.waitForResponse('**/api/status');
  releasePoll!();
  await staleResponse;
  await expect(page.getByText('Waiting for panel', { exact: true })).toBeVisible();
  await expect(page.getByText('Panel accepted frame', { exact: true })).toHaveCount(0);
});

test('creating a preset changes only the draft and keeps the explicit panel save', async ({ page }) => {
  const preset = createSampleLayout(); preset.name = 'New preset'; preset.widgets = [];
  let saves = 0;
  await page.route('**/api/layout', (route) => {
    if (route.request().method() === 'POST') saves++;
    return route.fulfill({ json: { document: createSampleLayout(), revision: 'saved' } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'saved', appliedRevision: 'saved' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Test uses HTML preview' } }));
  await page.route('**/layout-presets.json', (route) => route.fulfill({ json: { presets: [{ id: 'new', name: 'New preset', description: 'Empty.', document: preset }] } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save to panel' })).toBeEnabled();
  await page.getByRole('button', { name: 'Create layout', exact: true }).click();
  await page.getByRole('button', { name: 'Create New preset', exact: true }).click();
  await expect(page.locator('[data-widget-id]')).toHaveCount(0);
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
  expect(saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Save to panel' })).toBeEnabled();
});


test('browsing and adding library variants keeps panel writes explicit', async ({ page }) => {
  const saved = createSampleLayout();
  let saves = 0;
  await page.route('**/api/layout', (route) => {
    if (route.request().method() === 'POST') saves++;
    return route.fulfill({ json: { document: saved, revision: 'saved' } });
  });
  await page.route('**/api/status', (route) => route.fulfill({ json: { runtimeRunning: true, connected: true, requestedRevision: 'saved', appliedRevision: 'saved' } }));
  await page.route('**/api/palette', (route) => route.fulfill({ json: { palette: null } }));
  await page.route('**/api/preview', (route) => route.fulfill({ status: 422, json: { error: 'Test uses HTML preview' } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Save to panel' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Add widget', exact: true });
  await library.getByRole('button', { name: /^Gauges/ }).click();
  await library.getByLabel('Search widgets', { exact: true }).fill('Download');
  await expect(library.getByRole('button', { name: /^Add / })).toHaveCount(5);
  await library.getByRole('button', { name: 'Add Download gauge', exact: true }).click();
  await expect(page.getByLabel('Maximum', { exact: true })).toHaveValue('1024');
  await expect(page.getByLabel('Panel data source')).toHaveValue('network-down');
  await page.getByLabel('Display style').selectOption('segments');
  await expect(page.getByLabel('Maximum', { exact: true })).toHaveValue('1024');
  await expect(page.getByLabel('Panel data source')).toHaveValue('network-down');
  await expect(page.getByTestId('document-status')).toHaveText('Unsaved changes');
  expect(saves).toBe(0);
  expect(saved.widgets.some(({ id }) => id === 'network-down-gauge')).toBe(false);
  await expect(page.getByRole('button', { name: 'Save to panel' })).toBeEnabled();
});
