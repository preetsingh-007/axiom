/** Test helpers for the graph module (imported only by *.test.ts files). */
import { Vault } from '../vault';
import { insertBlocks, type NewBlock } from '../blocks';
import type { PageKind } from '../schema';

let n = 0;

/** Opens a fresh vault backed by fake-indexeddb. */
export function openTestVault(): Promise<Vault> {
  return Vault.open(`test-graph-${Date.now()}-${n++}`);
}

/** Creates a page with blocks (strings are text blocks). Returns the page id. */
export async function addPage(
  vault: Vault,
  title: string,
  blocks: (string | NewBlock)[],
  opts: { kind?: PageKind; id?: string; aliases?: string[]; sourceId?: string } = {},
): Promise<string> {
  const id = vault.createPage({ title, kind: opts.kind, id: opts.id, sourceId: opts.sourceId });
  if (opts.aliases) vault.updatePage(id, { aliases: opts.aliases });
  const { doc, release } = await vault.openPage(id);
  insertBlocks(
    doc,
    blocks.map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b)),
  );
  release();
  return id;
}
