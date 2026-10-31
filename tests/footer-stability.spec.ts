import { expect, test } from '@playwright/test';

// Include the reported widths and both sides of each responsive breakpoint.
const widths = [...new Set([
  ...Array.from({ length: 11 }, (_, i) => 737 + i * 3),
  ...Array.from({ length: 31 }, (_, i) => 1130 + i * 3),
  360, 560, 561, 900, 901, 1160, 1163,
])];

for (const connected of [false, true]) {
  test(`footer geometry and small drags survive changing notes and status (${connected ? 'connected' : 'offline'})`, async ({ page }) => {
    test.setTimeout(120_000);
    if (connected) {
      await page.route('**/api/status', route => route.fulfill({ json: { runtimeRunning: true, connected: true } }));
      await page.route('**/api/preview', route => route.fulfill({ status: 422, json: { error: 'Preview unavailable' } }));
    }
    await page.goto('/');
    const card = page.getByRole('group', { name: 'CPU load card' });
    const footer = page.getByRole('group', { name: 'Canvas view', exact: true });
    const failures: string[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await card.scrollIntoViewIfNeeded();
      // Let ResizeObserver finish measuring the new letterbox before pointer-down.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const heights = await footer.evaluate(element => {
        const notes = element.querySelector('.canvas-warnings summary');
        const notice = element.querySelector('.preview-notice');
        if (!notes || !notice) throw new Error('Missing footer slots');
        const oldNotes = notes.textContent;
        const oldNotice = notice.innerHTML;
        const heights: number[] = [];
        for (const label of ['0 layout notes', '1 layout note', '99 layout notes', '100+ layout notes']) {
          for (const status of ['', 'Rendering panel preview…', 'Live readings', 'Preview failed. '.repeat(60)]) {
            notes.textContent = label;
            notice.textContent = status;
            heights.push(element.getBoundingClientRect().height);
          }
        }
        notes.textContent = oldNotes;
        notice.innerHTML = oldNotice;
        return heights;
      });
      if (new Set(heights).size !== 1) failures.push(`${width}: footer heights ${[...new Set(heights)]}`);
      const before = await card.boundingBox();
      if (!before) throw new Error('Missing CPU card');
      const x = before.x + before.width / 2;
      const y = before.y + before.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 12, y);
      await page.waitForTimeout(80);
      await page.mouse.up();
      const after = await card.boundingBox();
      if (!after || after.x <= before.x + 1) failures.push(`${width}: small drag reverted`);
      // Reset to the sample position without accumulating drags or notes.
      const undo = page.getByRole('button', { name: 'Undo', exact: true });
      if (await undo.isEnabled()) await undo.click();
    }
    expect(failures).toEqual([]);
  });
}

for (const width of [1160, 1163]) {
  test(`first small CPU drag commits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    const card = page.getByRole('group', { name: 'CPU load card' });
    const before = (await card.boundingBox())!;
    const x = before.x + before.width / 2;
    const y = before.y + before.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 12, y);
    await page.waitForTimeout(80);
    await page.mouse.up();
    expect((await card.boundingBox())!.x).toBeGreaterThan(before.x + 1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await card.boundingBox())!.x).toBeCloseTo(before.x, 0);
  });
}

for (const size of [{ width: 1280, height: 800 }, { width: 1280, height: 600 }, { width: 1024, height: 700 }]) {
  test(`every panel fits common desktop windows without page scrolling (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.getByRole('complementary', { name: 'Layers' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    const viewport = await page.getByLabel('Canvas viewport', { exact: true }).boundingBox();
    console.log(`fit ${size.width}×${size.height}: ${viewport?.width}×${viewport?.height}`);
    expect(await page.locator('.stage-controls').evaluate(row => {
      const bounds = row.getBoundingClientRect();
      return [...row.children].every(child => child.getBoundingClientRect().right <= bounds.right + 1);
    })).toBe(true);
    expect(viewport?.width).toBeGreaterThanOrEqual(400);
    expect(viewport?.height).toBeGreaterThanOrEqual(300);
    expect(await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > innerWidth,
      y: document.documentElement.scrollHeight > innerHeight,
    }))).toEqual({ x: false, y: false });
  });
}
