import { test, expect, type Page } from '@playwright/test';
import { importFile, openApp, withAxiom } from './helpers';

async function importAndOpen(page: Page, file: string) {
  await importFile(page, file);
  const card = page.locator('.lib-card').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(page.locator('.reader')).toBeVisible();
}

/** Lasso a rectangle-ish polygon inside a rendered PDF page with the mouse (lasso tool on). */
async function lassoPdfRegion(page: Page, pageNum: number, fx0: number, fy0: number, fx1: number, fy1: number) {
  const pg = page.locator(`.pdfv-page[data-page="${pageNum}"]`);
  await expect(pg.locator('canvas.ready')).toBeVisible({ timeout: 20_000 });
  await expect(pg.locator('.textLayer span').first()).toBeAttached({ timeout: 20_000 });
  const b = (await pg.boundingBox())!;
  const X = (f: number) => b.x + f * b.width;
  const Y = (f: number) => b.y + f * b.height;
  await page.getByRole('button', { name: 'Lasso tool' }).click();
  await page.mouse.move(X(fx0), Y(fy0));
  await page.mouse.down();
  for (const [x, y] of [
    [fx1, fy0],
    [fx1, fy1],
    [fx0, fy1],
    [fx0, fy0 + 0.001],
  ] as const) {
    await page.mouse.move(X(x), Y(y), { steps: 6 });
  }
  await page.mouse.up();
}

test.describe('Source Vault', () => {
  test('imports a PDF with metadata, a BibTeX key and a TOC; remembers position', async ({ page }) => {
    await openApp(page);
    await importAndOpen(page, 'paper.pdf');
    const src = await withAxiom<{ title: string; pageCount: number; bib?: { bibKey?: string; doi?: string } }>(page, 'return axiom.vault.listSources()[0]');
    expect(src.pageCount).toBeGreaterThanOrEqual(3);
    expect(src.bib?.bibKey).toMatch(/^[a-z]+\d{4}[a-z]*$/);
    expect(src.bib?.doi).toMatch(/^10\./);
    await expect(page.locator('.reader-bibkey')).toHaveText(`@${src.bib!.bibKey}`);
    await expect(page.locator('.pdfv-page[data-page="1"] canvas.ready')).toBeVisible({ timeout: 20_000 });

    // scroll and check the view state is persisted
    await page.locator('.pdfv-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect.poll(() => withAxiom<number>(page, `return axiom.vault.getViewState(axiom.vault.listSources()[0].id)?.loc.page ?? 0`)).toBeGreaterThanOrEqual(2);
  });

  test('lasso & drop: extracts text as Markdown with a Wormhole anchor back to the source', async ({ page }) => {
    await openApp(page);
    await importAndOpen(page, 'paper.pdf');
    await lassoPdfRegion(page, 1, 0.06, 0.25, 0.49, 0.6);
    const card = page.locator('.extract-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.extract-preview')).not.toBeEmpty();
    await card.getByRole('button', { name: 'Send to Desk' }).click();

    // the block landed on today's page with an anchor
    const anchored = page.locator('.pane-desk .blk-anchor').first();
    await expect(anchored).toBeVisible({ timeout: 10_000 });
    const block = await withAxiom<{ text: string; anchor: { loc: { page: number; rect: number[] } } }>(
      page,
      `const id = axiom.vault.ensureDaily();
       const { doc } = await axiom.vault.openPage(id);
       return axiom.__blocks.snapshotPage(doc).find(b => b.anchor);`,
    );
    expect(block.anchor.loc.page).toBe(1);
    expect(block.text.length).toBeGreaterThan(20);
    expect(block.text).not.toMatch(/-\n/); // de-hyphenated

    // Wormhole: clicking the anchor scrolls the reader back and flashes the region
    await page.locator('.pdfv-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await anchored.click();
    await expect(page.locator('.pdfv-flash')).toBeVisible({ timeout: 10_000 });
  });

  test('text selection highlights persist', async ({ page }) => {
    await openApp(page);
    await importAndOpen(page, 'paper.pdf');
    const span = page.locator('.pdfv-page[data-page="1"] .textLayer span').nth(3);
    await expect(span).toBeAttached({ timeout: 20_000 });
    await span.dblclick();
    await expect(page.locator('.sel-menu')).toBeVisible();
    await page.getByRole('button', { name: 'Highlight yellow' }).click();
    await expect(page.locator('.pdfv-hl').first()).toBeVisible();
    await expect.poll(() => withAxiom<number>(page, `return axiom.vault.highlightsFor(axiom.vault.listSources()[0].id).length`)).toBe(1);
  });

  test('massive textbook: virtualised pages and TOC navigation', async ({ page }) => {
    await openApp(page);
    await importAndOpen(page, 'textbook.pdf');
    const count = await withAxiom<number>(page, 'return axiom.vault.listSources()[0].pageCount');
    expect(count).toBeGreaterThanOrEqual(300);
    // only a handful of pages are ever in the DOM
    await page.locator('.pdfv-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
    await page.waitForTimeout(400);
    expect(await page.locator('.pdfv-page').count()).toBeLessThan(16);
    // TOC jump
    const tocLinks = page.locator('.toc-link');
    if ((await tocLinks.count()) > 0) {
      await tocLinks.last().click();
      await expect(page.locator('.reader-page')).not.toHaveText(/^1 \//);
    }
  });

  test('slides: seminar notebook stacks slides with whiteboard space', async ({ page }) => {
    await openApp(page);
    await importAndOpen(page, 'slides.pdf');
    const src = await withAxiom<{ isSlides: boolean; pageCount: number }>(page, 'return axiom.vault.listSources()[0]');
    expect(src.isSlides).toBe(true);
    await page.getByRole('button', { name: 'Seminar notebook' }).click();
    await expect(page.locator('.page-title')).toContainText('Seminar');
    await expect(page.locator('.pane-desk .blk-slide')).toHaveCount(src.pageCount);
    await expect(page.locator('.pane-desk .blk-ink')).toHaveCount(src.pageCount);
    await expect(page.locator('.pane-desk .blk-slide img').first()).toBeVisible({ timeout: 20_000 });
  });

  test('EPUB opens with chapters and TOC', async ({ page }) => {
    await openApp(page);
    await importAndOpen(page, 'book.epub');
    await expect(page.locator('.epub-chapter .epub-html').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.toc-link').first()).toBeVisible();
  });

  test('PPTX opens as a vertical stream of slides', async ({ page }) => {
    await openApp(page);
    await importAndOpen(page, 'deck.pptx');
    await expect(page.locator('.pptx-slide-wrap')).toHaveCount(3, { timeout: 20_000 });
  });
});
