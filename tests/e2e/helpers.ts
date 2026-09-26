import { expect, type Page } from '@playwright/test';
import path from 'node:path';

export const FIXTURES = path.resolve(process.cwd(), 'tests/fixtures');

let seq = 0;
export function uniqueVault(prefix = 'e2e') {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Opens the app on an isolated vault with the debug handle (window.axiom) exposed. */
export async function openApp(page: Page, opts: { vault?: string; hash?: string } = {}) {
  const vault = opts.vault ?? uniqueVault();
  await page.goto(`/?vault=${vault}&debug${opts.hash ?? '#/stream'}`);
  await expect(page.locator('.app')).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { axiom?: unknown }).axiom);
  return vault;
}

/** Evaluates against the app services (window.axiom). */
export async function withAxiom<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    ([body, a]) => {
      const axiom = (window as unknown as { axiom: unknown }).axiom;
      // eslint-disable-next-line no-new-func
      return new Function('axiom', 'arg', `return (async () => { ${body} })()`)(axiom, a);
    },
    [fn, arg] as const,
  ) as Promise<T>;
}

/** Clicks into the last (empty) block of the visible page and types. */
export async function typeInNewBlock(page: Page, text: string, scope = '.pane-desk') {
  const tail = page.locator(`${scope} .blist-tail`).first();
  await tail.click();
  await expect(page.locator(`${scope} .cm-editor`).first()).toBeVisible();
  await page.keyboard.type(text, { delay: 5 });
}

export async function importFile(page: Page, file: string) {
  await page.evaluate(() => (location.hash = '#/library'));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Import/ }).first().click();
  await (await chooser).setFiles(path.join(FIXTURES, file));
}
