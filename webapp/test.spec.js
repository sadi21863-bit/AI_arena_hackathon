const { test, expect } = require('@playwright/test');

test('button increments counter', async ({ page }) => {
  await page.goto('http://localhost:8080');
  const btn = page.locator('#btn');
  const count = page.locator('#count');

  await expect(count).toHaveText('Count: 0');
  await btn.click();
  await expect(count).toHaveText('Count: 1');
  await btn.click();
  await expect(count).toHaveText('Count: 2');
});