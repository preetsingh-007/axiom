import { test, expect } from '@playwright/test';
import { openApp, typeInNewBlock, withAxiom } from './helpers';

test.describe('Active Desk', () => {
  test('boots into the Daily Stream with a welcome page', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('.day-today .day-title')).toHaveText('Today');
    await expect(page.locator('.sidebar')).toContainText('Welcome to Axiom');
  });

  test('writes markdown with math, splits and merges blocks', async ({ page }) => {
    await openApp(page);
    await typeInNewBlock(page, 'Energy is $E = mc^2$ and **bold**');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second block');
    await page.keyboard.press('Escape');
    const today = page.locator('.day-today');
    await expect(today.locator('.blk-rendered .katex').first()).toBeVisible();
    await expect(today.locator('.blk-rendered strong')).toHaveText('bold');
    await expect(today.locator('.blk-rendered', { hasText: 'second block' })).toBeVisible();

    // merge the second block back with Backspace at its start
    await today.getByText('second block').click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    await expect(today.locator('.blk-rendered', { hasText: 'boldsecond block' })).toBeVisible();
  });

  test('lists continue on Enter and fast typing after a split is never lost', async ({ page }) => {
    await openApp(page);
    await typeInNewBlock(page, '- alpha');
    await page.keyboard.press('Enter');
    await page.keyboard.type('beta');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // empty item leaves the list into a new block
    await page.keyboard.type('after the list', { delay: 0 });
    await page.keyboard.press('Escape');
    const today = page.locator('.day-today');
    await expect(today.locator('.blk-rendered li')).toHaveText(['alpha', 'beta']);
    await expect(today.locator('.blk-rendered', { hasText: 'after the list' })).toBeVisible();
  });

  test('deleted blocks come back with Undo (toast and Ctrl+Z)', async ({ page }) => {
    await openApp(page);
    await typeInNewBlock(page, 'keep me safe');
    await page.keyboard.press('Escape');
    const row = page.locator('.day-today .blk', { hasText: 'keep me safe' });
    await row.hover();
    await row.locator('.blk-handle').click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
    await page.locator('.ui-toast').getByRole('button', { name: 'Undo' }).click();
    await expect(row).toHaveCount(1);
    // again, restored with the keyboard
    await row.hover();
    await row.locator('.blk-handle').click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(row).toHaveCount(1);
  });

  test('[[links]] create concept pages with backlinks', async ({ page }) => {
    await openApp(page);
    // closeBrackets auto-pairs "[[", typing "]]" steps over the pair
    await typeInNewBlock(page, 'Studying [[Policy Gradient]] methods today');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('.day-today .md-wikilink', { hasText: 'Policy Gradient' }).click();
    await expect(page.locator('.page-title')).toHaveText('Policy Gradient');
    await expect(page.locator('.backlinks-wrap')).toContainText('methods today', { timeout: 15_000 });
  });

  test('slash command inserts a math block rendered with KaTeX', async ({ page }) => {
    await openApp(page);
    await typeInNewBlock(page, '/math');
    await page.keyboard.press('Enter');
    await expect(page.locator('.blk-math-edit')).toBeVisible();
    await page.keyboard.type('\\int_0^1 x\\,dx');
    await expect(page.locator('.blk-math-preview .katex')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.day-today .blk-math .katex-display')).toBeVisible();
  });

  test('command palette creates and opens a note', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+k');
    await page.getByRole('textbox', { name: 'Search' }).fill('Measure Theory Notes');
    await page.getByRole('option', { name: /Create page/ }).click();
    await expect(page.locator('.page-title')).toHaveText('Measure Theory Notes');
    await withAxiom(page, 'return axiom.vault.listPages().length').then((n) => expect(n).toBeGreaterThan(1));
  });

  test('side-quest panel opens without leaving the page', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+.');
    await expect(page.locator('.sidequest')).toBeVisible();
    await page.getByRole('textbox', { name: 'Look up concept' }).fill('Fisher information');
    await page.keyboard.press('Enter');
    await expect(page.locator('.sidequest .page-title')).toHaveText('Fisher information');
    await expect(page.locator('.day-today')).toBeVisible();
  });
});
