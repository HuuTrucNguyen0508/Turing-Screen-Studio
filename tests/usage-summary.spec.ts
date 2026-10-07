import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

for (const name of ['system-overview-clean', 'ai-usage-30d']) {
  test(`${name} imports and exports clean chrome without applying`, async ({ page }) => {
    let saves = 0;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/layout') saves++;
    });
    const document = JSON.parse(await readFile(`layouts/${name}.json`, 'utf8'));
    await page.goto('/');
    await page.getByLabel('Open layout file', { exact: true }).setInputFiles({
      name: `${name}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)),
    });
    const canvas = page.getByTestId('document-canvas');
    await expect(canvas.locator('.dashboard-header')).toHaveCount(0);
    await expect(canvas.locator('.dashboard-footer')).toHaveCount(0);
    if (name === 'ai-usage-30d') {
      await expect(canvas.locator('.summary-total')).toHaveText(['32.4', '148.20']);
      await expect(canvas.locator('.summary-row-value')).toHaveText(['24.8M', '6.9M', '700K', '105.60', '38.40', '4.20']);
      await expect(canvas.locator('.summary-percent')).toHaveText(['59', '32', '68']);
      const limits = canvas.locator('[data-widget-id="usage-limits"]');
      await expect(limits.locator('.summary-label').first()).toContainText('Usage left');
      const filled = Number(await limits.locator('.summary-fill').first().getAttribute('width'));
      const track = Number(await limits.locator('.summary-track').first().getAttribute('width'));
      expect(filled / track).toBeCloseTo(.59, 2);
      await expect(canvas.locator('.summary-footnote')).toContainText('Demo quota readings');
    }
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
    const download = await pending;
    expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(document);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(saves).toBe(0);
    expect(errors).toEqual([]);
  });
}

test('limits card hides an expired allowance and default catalog geometry separates four rows', async ({ page }) => {
  const document = JSON.parse(await readFile('layouts/ai-usage-30d.json', 'utf8'));
  document.widgets.find((widget: { id: string }) => widget.id === 'usage-limits').settings.detail =
    'Cached readings\nCodex\tWeekly\t41\tresets 3d\tcached\nClaude\t5-hour\t100\treset time passed\tstale\nClaude\tWeekly\t32\tresets 4d\tcached';
  await page.goto('/');
  await page.getByLabel('Open layout file', { exact: true }).setInputFiles({
    name: 'expired.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(page.getByTestId('document-canvas').locator('.summary-percent')).toHaveText(['59', '—', '68']);
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add widget', exact: true });
  await dialog.getByLabel('Search widgets', { exact: true }).fill('Provider limits');
  await dialog.getByRole('button', { name: 'Add Provider limits', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Height', exact: true })).toHaveValue('344');
});
