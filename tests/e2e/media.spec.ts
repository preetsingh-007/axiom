import { test, expect, type Page } from '@playwright/test';
import { openApp, withAxiom } from './helpers';
import { word } from '../../src/core/ink/testing/synth';

/** A PNG photo-like test image (gradient), `w`×`h`, drawn by the browser. */
async function pngBuffer(page: Page, w: number, h: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      const grd = g.createLinearGradient(0, 0, w, h);
      grd.addColorStop(0, '#9ad0ec');
      grd.addColorStop(1, '#f7d794');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
      const url = c.toDataURL('image/png');
      return url.slice(url.indexOf(',') + 1);
    },
    [w, h] as const,
  );
  return Buffer.from(b64, 'base64');
}

/** Waits for the slash-command menu (Enter right as it opens is ignored by the editor). */
async function commandMenu(page: Page) {
  await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
  await page.waitForTimeout(150);
}

/** Clicks into a text block and waits for its editor before typing. */
async function editBlock(page: Page, text?: string) {
  await page.locator('.blk-rendered', text ? { hasText: text } : {}).first().click();
  await expect(page.locator('.cm-editor')).toBeVisible();
}

async function newPage(page: Page, blocks: string) {
  const id = await withAxiom<string>(
    page,
    `const id = axiom.vault.createPage({ title: 'Media' });
     const { doc } = await axiom.vault.openPage(id);
     axiom.__blocks.insertBlocks(doc, ${blocks});
     return id;`,
  );
  await page.evaluate((pid) => (location.hash = `#/page/${pid}`), id);
  await expect(page.locator('.blk').first()).toBeVisible();
  return id;
}

async function snapshot(page: Page, id: string) {
  return withAxiom<{ type: string; text: string; image?: { w: number; h: number; blobId: string }; displayWidth?: number; strokes?: { size: number }[]; labels?: unknown[] }[]>(
    page,
    `const { doc } = await axiom.vault.openPage(arg); return axiom.__blocks.snapshotPage(doc);`,
    id,
  );
}

/** Adds an image block holding a stored picture. */
async function seedImage(page: Page, w: number, h: number) {
  return withAxiom<string>(
    page,
    `const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
     const g = c.getContext('2d'); g.fillStyle = '#9ad0ec'; g.fillRect(0, 0, ${w}, ${h});
     const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
     const blobId = await axiom.vault.putBlob(blob);
     const id = axiom.vault.createPage({ title: 'Photo' });
     const { doc } = await axiom.vault.openPage(id);
     axiom.__blocks.insertBlocks(doc, [{ type: 'text', text: 'A photo' }, { type: 'image', image: { blobId, w: ${w}, h: ${h}, mime: 'image/png' } }]);
     return id;`,
  );
}

test.describe('Photos in notes', () => {
  test('the image command adds photos, downscaling large ones', async ({ page }) => {
    await openApp(page);
    const id = await newPage(page, `[{ type: 'text', text: '' }]`);
    await editBlock(page);
    await page.keyboard.type('/image');
    await commandMenu(page);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles([
      { name: 'big.png', mimeType: 'image/png', buffer: await pngBuffer(page, 3000, 1500) },
      { name: 'small.png', mimeType: 'image/png', buffer: await pngBuffer(page, 300, 200) },
    ]);
    await expect.poll(async () => (await snapshot(page, id)).map((b) => b.type)).toEqual(['image', 'image']);
    const [big, small] = await snapshot(page, id);
    expect(big.image).toMatchObject({ w: 2560, h: 1280 });
    expect(small.image).toMatchObject({ w: 300, h: 200 });
    await expect(page.locator('.blk-image-frame img')).toHaveCount(2);
  });

  test('the camera command asks for a capture', async ({ page }) => {
    await openApp(page);
    await newPage(page, `[{ type: 'text', text: '' }]`);
    await editBlock(page);
    await page.keyboard.type('/camera');
    await commandMenu(page);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    const fc = await chooser;
    expect(await fc.element().getAttribute('capture')).toBe('environment');
    expect(await fc.element().getAttribute('accept')).toBe('image/*');
  });

  test('pasting a screenshot into a block inserts an image after it', async ({ page }) => {
    await openApp(page);
    const id = await newPage(page, `[{ type: 'text', text: 'Before' }]`);
    await editBlock(page, 'Before');
    const bytes = [...(await pngBuffer(page, 40, 30))];
    await page.evaluate((data) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(data)], 'shot.png', { type: 'image/png' }));
      document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, bytes);
    await expect.poll(async () => (await snapshot(page, id)).map((b) => `${b.type}:${b.text}`)).toEqual(['text:Before', 'image:']);
  });

  test('drag the corner to resize; the width is kept as a fraction of the column', async ({ page }) => {
    await openApp(page);
    const id = await seedImage(page, 1600, 900);
    await page.evaluate((pid) => (location.hash = `#/page/${pid}`), id);
    const frame = page.locator('.blk-image-frame');
    await expect(frame.locator('img')).toBeVisible();
    const before = (await frame.boundingBox())!;
    await frame.hover();
    const handle = page.locator('.blk-image-resize');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x - before.width / 2, hb.y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page, id))[1].displayWidth).toBe(0.5);
    const after = (await frame.boundingBox())!;
    expect(after.width).toBeCloseTo(before.width / 2, -1);
    // double-click resets to the natural size
    await frame.hover();
    await handle.dblclick();
    await expect.poll(async () => (await snapshot(page, id))[1].displayWidth).toBeUndefined();
  });

  test('annotate a photo in the focus view; annotations show in the note and can be hidden', async ({ page }) => {
    await openApp(page);
    const id = await seedImage(page, 1200, 800);
    await page.evaluate((pid) => (location.hash = `#/page/${pid}`), id);
    const frame = page.locator('.blk-image-frame');
    await expect(frame.locator('img')).toBeVisible();
    await frame.hover();
    await page.getByRole('button', { name: 'Annotate' }).click();
    await expect(page.locator('.focus-view .ink-photo-img')).toBeVisible();
    await page.keyboard.press('p');
    const s = (await page.locator('.focus-view .ink-surface').boundingBox())!;
    await page.mouse.move(s.x + 100, s.y + 100);
    await page.mouse.down();
    await page.mouse.move(s.x + 400, s.y + 300, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page, id))[1].strokes?.length ?? 0).toBe(1);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.focus-view')).toHaveCount(0);
    await expect(page.locator('.blk-annot svg path')).toHaveCount(1);
    await frame.hover();
    await page.getByRole('button', { name: 'Hide annotations' }).click();
    await expect(page.locator('.blk-annot')).toHaveCount(0);
  });
});

test.describe('Focus view', () => {
  test('zooms with buttons and trackpad pinch; zoomed-in strokes are finer; Escape closes', async ({ page }) => {
    await openApp(page);
    const id = await newPage(page, `[{ type: 'text', text: 'Board' }, { type: 'ink', height: 500 }]`);
    await page.locator('.blk-ink').hover();
    await page.getByRole('button', { name: 'Open in focus view (zoom)' }).click();
    await expect(page.locator('.focus-view')).toBeVisible();
    const zoomLabel = page.locator('.focus-zoom-value');
    await expect(zoomLabel).toHaveText('100%');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoomLabel).toHaveText('125%');
    // trackpad pinch = ctrl + wheel
    const sc = (await page.locator('.focus-scroll').boundingBox())!;
    await page.mouse.move(sc.x + 200, sc.y + 200);
    await page.keyboard.down('Control');
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -20);
    await page.keyboard.up('Control');
    await expect.poll(async () => parseInt((await zoomLabel.textContent()) ?? '0', 10)).toBeGreaterThan(300);
    await page.keyboard.press('p');
    await page.mouse.move(sc.x + 200, sc.y + 200);
    await page.mouse.down();
    await page.mouse.move(sc.x + 400, sc.y + 260, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page, id))[1].strokes?.length ?? 0).toBe(1);
    const size = (await snapshot(page, id))[1].strokes![0].size;
    expect(size).toBeLessThan(2.5);
    // the stroke shows in the note behind
    await page.keyboard.press('Escape');
    await expect(page.locator('.focus-view')).toHaveCount(0);
    await expect(page.locator('.blk-ink .ink-surface')).toHaveAttribute('aria-label', /1 stroke/);
  });

  test('two fingers pinch-zoom the focus view @touch', async ({ page }) => {
    await openApp(page);
    await newPage(page, `[{ type: 'text', text: 'Board' }, { type: 'ink', height: 500 }]`);
    await page.locator('.blk-ink .blk-expand').click();
    await expect(page.locator('.focus-view')).toBeVisible();
    const sc = (await page.locator('.focus-scroll').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const cx = sc.x + sc.width / 2;
    const cy = sc.y + 200;
    const pts = (d: number) => [
      { x: cx - d / 2, y: cy, id: 1 },
      { x: cx + d / 2, y: cy + 2, id: 2 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(80) });
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(80 + i * 16) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => parseInt((await page.locator('.focus-zoom-value').textContent()) ?? '0', 10)).toBeGreaterThan(180);
  });
});

test.describe('Handwriting conversion', () => {
  async function withMockAI(page: Page, answer: string) {
    await page.route('https://mock-ai.test/v1/chat/completions', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: answer } }] }) }),
    );
    await withAxiom(page, `axiom.aiConfig.current = { order: ['openai'], openai: { baseUrl: 'https://mock-ai.test/v1', model: 'mock' } };`);
  }

  test('Beautify previews typed text; Accept turns it into a note block', async ({ page }) => {
    await openApp(page);
    await withMockAI(page, '{"kind":"text","content":"hello world"}');
    const strokes = word('hello', 120, 120, 30);
    const id = await withAxiom<string>(
      page,
      `const id = axiom.vault.createPage({ title: 'Notes' });
       const { doc } = await axiom.vault.openPage(id);
       axiom.__blocks.insertBlocks(doc, [{ type: 'text', text: 'Intro' }, { type: 'ink', height: 400, strokes: arg }, { type: 'text', text: 'Outro' }]);
       return id;`,
      strokes,
    );
    await page.evaluate((pid) => (location.hash = `#/page/${pid}`), id);
    const surface = page.locator('.blk-ink .ink-surface');
    await expect(surface).toHaveAttribute('aria-label', /5 strokes/);
    const box = (await surface.boundingBox())!;
    const k = box.width / 1000;
    await page.keyboard.press('l');
    const P = (x: number, y: number) => [box.x + x * k, box.y + y * k] as const;
    await page.mouse.move(...P(90, 90));
    await page.mouse.down();
    for (const [x, y] of [
      [330, 90],
      [330, 170],
      [90, 170],
      [90, 92],
    ]) {
      await page.mouse.move(...P(x, y), { steps: 4 });
    }
    await page.mouse.up();
    await page.getByRole('button', { name: 'Beautify', exact: true }).click();
    await expect(page.locator('.ink-preview')).toHaveText('hello world');
    // nothing written yet
    expect((await snapshot(page, id)).map((b) => b.type)).toEqual(['text', 'ink', 'text']);
    await page.locator('.ink-preview-bar').getByRole('button', { name: 'Accept' }).click();
    await expect.poll(async () => (await snapshot(page, id)).map((b) => `${b.type}:${b.text}`)).toEqual(['text:Intro', 'text:hello world', 'text:Outro']);
    await expect(page.locator('.blk-rendered', { hasText: 'hello world' })).toBeVisible();
  });

  test('Keep ink discards the conversion', async ({ page }) => {
    await openApp(page);
    await withMockAI(page, '{"kind":"math","content":"a^2+b^2"}');
    const id = await withAxiom<string>(
      page,
      `const id = axiom.vault.createPage({ title: 'Notes' });
       const { doc } = await axiom.vault.openPage(id);
       axiom.__blocks.insertBlocks(doc, [{ type: 'ink', height: 400, strokes: arg }]);
       return id;`,
      word('abc', 120, 120, 30),
    );
    await page.evaluate((pid) => (location.hash = `#/page/${pid}`), id);
    const surface = page.locator('.blk-ink .ink-surface');
    await expect(surface).toHaveAttribute('aria-label', /3 strokes/);
    const box = (await surface.boundingBox())!;
    const k = box.width / 1000;
    await page.keyboard.press('l');
    await page.mouse.move(box.x + 90 * k, box.y + 90 * k);
    await page.mouse.down();
    await page.mouse.move(box.x + 260 * k, box.y + 90 * k, { steps: 4 });
    await page.mouse.move(box.x + 260 * k, box.y + 170 * k, { steps: 4 });
    await page.mouse.move(box.x + 90 * k, box.y + 170 * k, { steps: 4 });
    await page.mouse.move(box.x + 90 * k, box.y + 92 * k, { steps: 4 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Beautify', exact: true }).click();
    await expect(page.locator('.ink-preview .katex')).toBeVisible();
    await page.locator('.ink-preview-bar').getByRole('button', { name: 'Keep ink' }).click();
    await expect(page.locator('.ink-preview')).toHaveCount(0);
    const snap = await snapshot(page, id);
    expect(snap.map((b) => b.type)).toEqual(['ink']);
    expect(snap[0].strokes).toHaveLength(3);
  });
});
