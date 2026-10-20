import type { Page } from '@playwright/test';

/** Choose an item from a header menu ("Layout" or "Settings"). */
export async function chooseMenu(page: Page, menu: 'Layout' | 'Settings', item: string) {
  await page.getByRole('button', { name: menu, exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Export JSON is the primary header action offline and a Layout menu item when the panel is connected. */
export async function exportJson(page: Page) {
  const direct = page.getByRole('button', { name: 'Export JSON', exact: true });
  if (await direct.count()) await direct.click();
  else await chooseMenu(page, 'Layout', 'Export JSON');
}
