import { test, expect } from '@playwright/test';
import { openApp, typeInNewBlock, withAxiom } from './helpers';

test('#flashcard blocks become cloze cards reviewed with FSRS', async ({ page }) => {
  await openApp(page);
  await typeInNewBlock(page, 'The **Kullback–Leibler divergence** is never negative. #flashcard');
  await page.keyboard.press('Escape');

  await expect
    .poll(() => withAxiom<number>(page, `return [...axiom.vault.cards.values()].filter(c => c.front.includes('Kullback')).length`), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await page.evaluate(() => (location.hash = '#/review'));
  const showAnswer = page.getByRole('button', { name: /Show answer/i });
  await expect(showAnswer).toBeVisible({ timeout: 10_000 });
  // welcome page also carries a flashcard; answer until ours has been seen
  for (let i = 0; i < 6; i++) {
    if (!(await showAnswer.isVisible().catch(() => false))) break;
    await showAnswer.click();
    await page.getByRole('button', { name: /Good/ }).click();
  }
  const reviewed = await withAxiom<number>(page, `return [...axiom.vault.cards.values()].filter(c => c.reps > 0).length`);
  expect(reviewed).toBeGreaterThan(0);
  const log = await withAxiom<number>(page, 'return axiom.vault.reviewLog.length');
  expect(log).toBeGreaterThan(0);
});
