import { test, expect, type Page } from '@playwright/test';
import { importFile, openApp, withAxiom } from './helpers';

async function watchLongTasks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push(e.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
}
const longTasks = (page: Page) => page.evaluate(() => (window as unknown as { __long: number[] }).__long);

// tracing snapshots the whole DOM on every action and would dominate the measurements
test.use({ trace: 'off' });

test.describe('performance', () => {
  test('a 2,000-block page renders quickly and typing stays jank-free', async ({ page }) => {
    await openApp(page);
    const id = await withAxiom<string>(
      page,
      `const id = axiom.vault.createPage({ title: 'Huge page' });
       const { doc } = await axiom.vault.openPage(id);
       const specs = [];
       for (let i = 0; i < 2000; i++) specs.push({ type: 'text', text: 'Paragraph ' + i + ' with $x_' + (i % 10) + '$ and a [[Concept ' + (i % 50) + ']] link.' });
       axiom.__blocks.insertBlocks(doc, specs);
       return id;`,
    );
    const t0 = Date.now();
    await page.evaluate((pid) => (location.hash = `#/page/${pid}`), id);
    await expect(page.locator('.blk-rendered', { hasText: /^Paragraph 10 with/ })).toBeVisible({ timeout: 20_000 });
    const firstPaint = Date.now() - t0;
    // the rest mounts progressively in idle time; the whole page ends up in the DOM
    await expect(page.locator('.blk-rendered', { hasText: /^Paragraph 1999 with/ })).toBeAttached({ timeout: 60_000 });
    const full = Date.now() - t0;
    console.log(`[perf] 2000-block page: first paint ${firstPaint} ms, fully mounted ${full} ms`);
    expect(firstPaint).toBeLessThan(1500);
    // jumping to the end renders immediately
    await page.locator('.desk-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(page.locator('.blk-rendered', { hasText: /^Paragraph 1999 with/ })).toBeVisible();

    await watchLongTasks(page);
    await page.locator('.blk-rendered', { hasText: /^Paragraph 5 with/ }).click();
    await page.keyboard.type(' typing without jank', { delay: 15 });
    await page.keyboard.press('Escape');
    const long = await longTasks(page);
    console.log(`[perf] long tasks while typing: ${JSON.stringify(long.map(Math.round))}`);
    expect(Math.max(0, ...long)).toBeLessThan(250);
  });

  test('search across 500 pages returns instantly', async ({ page }) => {
    await openApp(page);
    await withAxiom(
      page,
      `for (let p = 0; p < 500; p++) {
         const id = axiom.vault.createPage({ title: 'Paper notes ' + p });
         const { doc, release } = await axiom.vault.openPage(id);
         const specs = [];
         for (let i = 0; i < 20; i++) specs.push({ type: 'text', text: 'Block ' + i + ' about ' + ['entropy', 'mutual information', 'policy gradient', 'variational inference', 'kernel methods'][ (p + i) % 5 ] + ' number ' + (p * 20 + i) });
         axiom.__blocks.insertBlocks(doc, specs);
         release();
       }
       await axiom.graph.flush();`,
    );
    const ms = await withAxiom<number>(
      page,
      `const t = performance.now();
       for (let i = 0; i < 20; i++) axiom.graph.search('variational infer', { limit: 20 });
       return (performance.now() - t) / 20;`,
    );
    console.log(`[perf] search avg over 10k blocks: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(50);
    const hits = await withAxiom<number>(page, `return axiom.graph.search('variational inference', { limit: 50 }).length`);
    expect(hits).toBeGreaterThan(10);
  });

  test('scrolling a 300+ page textbook keeps memory bounded', async ({ page }) => {
    await openApp(page);
    await importFile(page, 'textbook.pdf');
    await page.locator('.lib-card').first().click();
    await expect(page.locator('.pdfv-page[data-page="1"] canvas.ready')).toBeVisible({ timeout: 30_000 });
    await watchLongTasks(page);
    const scroller = page.locator('.pdfv-scroll');
    for (let i = 1; i <= 20; i++) {
      await scroller.evaluate((el, f) => (el.scrollTop = el.scrollHeight * f), i / 20);
      await page.waitForTimeout(60);
    }
    expect(await page.locator('.pdfv-page').count()).toBeLessThan(16);
    const long = await longTasks(page);
    console.log(`[perf] long tasks while flinging through textbook: max ${Math.round(Math.max(0, ...long))} ms`);
    expect(Math.max(0, ...long)).toBeLessThan(600);
  });
});
