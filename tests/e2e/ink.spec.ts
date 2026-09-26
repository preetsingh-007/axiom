import { test, expect, type Page } from '@playwright/test';
import { openApp, withAxiom } from './helpers';

async function inkPage(page: Page) {
  const id = await withAxiom<string>(
    page,
    `const id = axiom.vault.createPage({ title: 'Sketches' });
     const { doc } = await axiom.vault.openPage(id);
     axiom.__blocks.insertBlocks(doc, [{ type: 'text', text: 'Diagram below' }, { type: 'ink', height: 600 }]);
     return id;`,
  );
  await page.evaluate((pid) => (location.hash = `#/page/${pid}`), id);
  const canvas = page.locator('.blk-ink canvas').first();
  await expect(canvas).toBeVisible();
  return id;
}

async function strokes(page: Page, id: string) {
  return withAxiom<{ n: number; beautified: unknown }>(
    page,
    `const { doc } = await axiom.vault.openPage(arg);
     const ink = axiom.__blocks.snapshotPage(doc).find(b => b.type === 'ink');
     return { n: ink.strokes.length, beautified: ink.beautified ?? null };`,
    id,
  );
}

async function drawCircle(page: Page, cx: number, cy: number, r: number) {
  await page.mouse.move(cx + r, cy);
  await page.mouse.down();
  for (let i = 1; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  await page.mouse.up();
}

test('draws with the pen, erases, and beautifies a circle into a shape (reversible)', async ({ page }) => {
  await openApp(page);
  const id = await inkPage(page);
  const box = (await page.locator('.blk-ink .ink-surface, .blk-ink [role="img"]').first().boundingBox())!;

  await page.keyboard.press('p'); // pen tool
  await drawCircle(page, box.x + 200, box.y + 150, 70);
  await page.mouse.move(box.x + 350, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 480, box.y + 100, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await strokes(page, id)).n).toBe(2);

  // eraser removes the line
  await page.keyboard.press('e');
  await page.mouse.move(box.x + 415, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 415, box.y + 120, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await strokes(page, id)).n).toBe(1);

  // lasso the circle and double-tap inside the selection → Beautify
  await page.keyboard.press('l');
  await page.mouse.move(box.x + 100, box.y + 50);
  await page.mouse.down();
  for (const [x, y] of [
    [300, 50],
    [300, 250],
    [100, 250],
    [100, 52],
  ]) {
    await page.mouse.move(box.x + x, box.y + y, { steps: 5 });
  }
  await page.mouse.up();
  await page.mouse.dblclick(box.x + 200, box.y + 150);
  await expect.poll(async () => JSON.stringify((await strokes(page, id)).beautified), { timeout: 10_000 }).toContain('"shape"');
  const b = (await strokes(page, id)).beautified as { active: boolean; items: { kind: string; shape: string }[] };
  expect(b.active).toBe(true);
  expect(b.items[0].shape).toMatch(/circle|ellipse/);
  // raw ink is preserved
  expect((await strokes(page, id)).n).toBe(1);
});
