import { test, expect, type Page } from '@playwright/test';
import { openApp, withAxiom } from './helpers';

async function seedPage(page: Page) {
  const id = await withAxiom<string>(
    page,
    `const id = axiom.vault.createPage({ title: 'Assignment 3' });
     const { doc } = await axiom.vault.openPage(id);
     const { insertBlocks } = axiom.__blocks;
     insertBlocks(doc, [
       { type: 'text', text: 'Question 1. Prove the policy improvement theorem.' },
       { type: 'text', text: 'Question 2. Derive the REINFORCE estimator.' },
       { type: 'text', text: 'Question 3. Show the Bellman operator is a contraction.' },
     ]);
     return id;`,
  );
  await page.evaluate((pid) => (location.hash = `#/page/${pid}`), id);
  await expect(page.locator('.blk-rendered', { hasText: 'Question 3' })).toBeVisible();
  return id;
}

async function blockTypes(page: Page, id: string) {
  return withAxiom<string[]>(page, `const { doc } = await axiom.vault.openPage(arg); return axiom.__blocks.snapshotPage(doc).map(b => b.type + ':' + (b.height ?? ''));`, id);
}

/** Two-finger vertical gesture through CDP touch events. */
async function twoFinger(page: Page, x: number, y: number, from: number, to: number, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const pts = (d: number) => [
    { x, y: y - d / 2, id: 1 },
    { x: x + 4, y: y + d / 2, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
  for (let i = 1; i <= steps; i++) {
    const d = from + ((to - from) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('Elastic canvas (accordion margin) @touch', () => {
  test('two-finger spread injects whiteboard space between paragraphs; pinch snaps it shut', async ({ page }) => {
    await openApp(page);
    const id = await seedPage(page);
    const q1 = page.locator('.blk', { hasText: 'Question 1' });
    const q2 = page.locator('.blk', { hasText: 'Question 2' });
    const b1 = (await q1.boundingBox())!;
    const b2 = (await q2.boundingBox())!;
    const gapY = (b1.y + b1.height + b2.y) / 2;
    const x = b1.x + b1.width / 2;

    await twoFinger(page, x, gapY, 40, 280);
    await expect.poll(() => blockTypes(page, id)).toEqual(expect.arrayContaining([expect.stringMatching(/^ink:/)]));
    const types = await blockTypes(page, id);
    expect(types[1]).toMatch(/^ink:\d+/); // inserted between Q1 and Q2
    expect(Number(types[1].split(':')[1])).toBeGreaterThan(150);

    // pinch over the (empty) whiteboard closes it
    const ink = page.locator('.blk-ink').first();
    const ib = (await ink.boundingBox())!;
    await twoFinger(page, ib.x + ib.width / 2, ib.y + ib.height / 2, 300, 20, 10);
    await expect.poll(() => blockTypes(page, id)).toEqual(['text:', 'text:', 'text:']);
  });

  test('trackpad pinch (ctrl+wheel) opens space on laptops', async ({ page }) => {
    await openApp(page);
    const id = await seedPage(page);
    const q2 = page.locator('.blk', { hasText: 'Question 2' });
    const b = (await q2.boundingBox())!;
    await page.mouse.move(b.x + 100, b.y + b.height + 2);
    for (let i = 0; i < 10; i++) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -12);
      await page.keyboard.up('Control');
    }
    await expect.poll(() => blockTypes(page, id), { timeout: 5000 }).toEqual(expect.arrayContaining([expect.stringMatching(/^ink:/)]));
  });
});
