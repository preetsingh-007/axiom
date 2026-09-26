import { test, expect } from '@playwright/test';
import { openApp, uniqueVault, withAxiom } from './helpers';

const RELAY = 'ws://localhost:4455';

/**
 * Two isolated browser contexts = two devices (separate IndexedDB). They join the same
 * encrypted relay room and must converge on concurrent edits in real time.
 */
test('real-time encrypted sync between two devices via the relay', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  const vault = uniqueVault('sync');
  await openApp(pa, { vault });
  await openApp(pb, { vault });

  const secret = await withAxiom<string>(
    pa,
    `const { generateSyncSecret } = axiom.__sync ?? {};
     return null;`,
  ).catch(() => null);
  expect(secret).toBeNull();

  // configure both devices through the Settings UI path (join code)
  await pa.evaluate(() => (location.hash = '#/settings/sync'));
  await pa.getByRole('button', { name: 'Create a sync key' }).click();
  await pa.getByPlaceholder('wss://relay.example.com').fill(RELAY);
  await pa.getByText('Real-time sync through the relay').click();
  const code = await pa.locator('.set-code code').innerText();
  await pa.getByRole('button', { name: 'Save' }).first().click();

  await pb.evaluate(() => (location.hash = '#/settings/sync'));
  await pb.getByPlaceholder(/paste a join code/).fill(code);
  await pb.getByRole('button', { name: 'Join' }).click();
  await pb.getByRole('button', { name: 'Save' }).first().click();

  await expect(pa.locator('.set-status')).toContainText('1 other device online', { timeout: 20_000 });
  await expect(pb.locator('.set-status')).toContainText('1 other device online', { timeout: 20_000 });

  // A creates a page with content; B sees it
  const pageId = await withAxiom<string>(
    pa,
    `const id = axiom.vault.createPage({ title: 'Shared derivation' });
     const { doc } = await axiom.vault.openPage(id);
     const order = doc.getArray('order'); const blocks = doc.getMap('blocks');
     const Y = doc.constructor;
     return id;`,
  );
  await pa.evaluate((id) => (location.hash = `#/page/${id}`), pageId);
  await pa.locator('.blist-tail').click();
  await pa.keyboard.type('Bellman optimality from device A');
  await pa.keyboard.press('Escape');

  await pb.evaluate((id) => (location.hash = `#/page/${id}`), pageId);
  await expect(pb.locator('.page-title')).toHaveText('Shared derivation', { timeout: 20_000 });
  await expect(pb.locator('.blk-rendered', { hasText: 'Bellman optimality from device A' })).toBeVisible({ timeout: 20_000 });

  // concurrent edits on both sides converge
  await pa.locator('.blist-tail').click();
  await pa.keyboard.type('line from A');
  await pa.keyboard.press('Escape');
  await pb.locator('.blist-tail').click();
  await pb.keyboard.type('line from B');
  await pb.keyboard.press('Escape');
  for (const p of [pa, pb]) {
    await expect(p.locator('.blk-rendered', { hasText: 'line from A' })).toBeVisible({ timeout: 20_000 });
    await expect(p.locator('.blk-rendered', { hasText: 'line from B' })).toBeVisible({ timeout: 20_000 });
  }
  const orderA = await pa.locator('.page .blk-rendered').allInnerTexts();
  const orderB = await pb.locator('.page .blk-rendered').allInnerTexts();
  expect(orderA).toEqual(orderB);

  await a.close();
  await b.close();
});

test('tabs of the same device stay in sync without any server', async ({ browser }) => {
  const ctx = await browser.newContext();
  const p1 = await ctx.newPage();
  const vault = uniqueVault('tabs');
  await openApp(p1, { vault });
  const p2 = await ctx.newPage();
  await openApp(p2, { vault });
  await p1.locator('.day-today .blist-tail').click();
  await p1.keyboard.type('typed in tab one');
  await p1.keyboard.press('Escape');
  await expect(p2.locator('.day-today .blk-rendered', { hasText: 'typed in tab one' })).toBeVisible({ timeout: 10_000 });
  await ctx.close();
});
