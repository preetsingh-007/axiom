import { test, expect } from '@playwright/test';
import { openApp, withAxiom } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await withAxiom(
    page,
    `const a = axiom.vault.createPage({ title: 'Policy gradients' });
     const b = axiom.vault.createPage({ title: 'Paper reading' });
     for (const [id, text] of [[a, 'REINFORCE is unbiased #rl [[Variance reduction]]'], [b, 'Actor-critic trick #rl #todo'], [b, 'Baselines reduce variance [[Variance reduction]] #flashcard']]) {
       const { doc } = await axiom.vault.openPage(id);
       axiom.__blocks.insertBlocks(doc, [{ type: 'text', text }]);
     }
     await axiom.graph.flush();`,
  );
});

test('lenses aggregate live, editable blocks across pages and can be saved', async ({ page }) => {
  await page.evaluate(() => (location.hash = '#/lens'));
  await page.getByRole('textbox', { name: 'Lens query' }).fill('#rl -#todo OR [[Variance reduction]]');
  await expect(page.locator('.lens-count')).toContainText('2 blocks across 2 pages');
  await page.getByRole('textbox', { name: 'Lens name' }).fill('RL reading');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.sidebar')).toContainText('RL reading');
  // blocks are editable in place
  await page.locator('.lens-blocks .blk-rendered', { hasText: 'REINFORCE' }).click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.type(' (edited in lens)');
  await page.keyboard.press('Escape');
  await expect.poll(() => withAxiom<string>(page, `return axiom.graph.search('edited in lens')[0]?.title ?? ''`)).toBe('Policy gradients');
});

test('graph view renders nodes and opens a page on click', async ({ page }) => {
  await page.evaluate(() => (location.hash = '#/graph'));
  const canvas = page.locator('.graph-route canvas');
  await expect(canvas).toBeVisible();
  const data = await withAxiom<{ nodes: { title: string }[] }>(page, 'return axiom.graph.graph()');
  const titles = data.nodes.map((n) => n.title);
  expect(titles).toEqual(expect.arrayContaining(['Policy gradients', 'Variance reduction', 'rl']));
  expect(titles).not.toContain('flashcard');
  await page.getByPlaceholder(/Highlight nodes/).fill('Policy');
  await page.waitForTimeout(300);
});
