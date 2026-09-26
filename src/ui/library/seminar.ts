import type { NewBlock } from '../../core/blocks';
import { blockIds, getBlock, insertBlocks } from '../../core/blocks';
import type { SourceMeta } from '../../core/schema';
import { getServicesUnsafe } from '../app/servicesRef';
import { getDeck } from './PptxViewer';
import { renderSlideToCanvas } from './pptx/PptxSlideView';
import { blobToImageRef } from '../desk/blocks/imageImport';

/**
 * The Seminar Synthesizer: turns a slide deck into a Desk page where every slide is stacked
 * vertically with blank whiteboard space beneath it, so proofs can be worked through
 * alongside the speaker. Slides link back to the source (Wormhole).
 */
export async function createSeminarNotebook(source: SourceMeta): Promise<string> {
  const { vault } = getServicesUnsafe();
  const existing = vault.listPages().find((p) => p.kind === 'seminar' && p.sourceId === source.id);
  if (existing) {
    const { doc, release } = await vault.openPage(existing.id);
    const filled = blockIds(doc).some((id) => getBlock(doc, id)?.get('type') === 'slide');
    release();
    if (filled) return existing.id;
  }
  // build everything first: a failure (e.g. the file isn't on this device yet) leaves no empty page
  const blocks = await seminarBlocks(source);
  const pageId = existing?.id ?? vault.createPage({ title: `Seminar · ${source.title}`, kind: 'seminar', sourceId: source.id });
  const { doc, release } = await vault.openPage(pageId);
  try {
    insertBlocks(doc, blocks);
  } finally {
    release();
  }
  return pageId;
}

async function seminarBlocks(source: SourceMeta): Promise<NewBlock[]> {
  const { vault } = getServicesUnsafe();
  const blocks: NewBlock[] = [];
  const now = Date.now();
  if (source.kind === 'pdf') {
    const n = source.pageCount ?? 0;
    for (let p = 1; p <= n; p++) {
      blocks.push({ type: 'slide', anchor: { sourceId: source.id, loc: { page: p }, createdAt: now } });
      blocks.push({ type: 'ink', height: 420 });
    }
  } else if (source.kind === 'pptx') {
    const deck = await getDeck(source.id, () => vault.getBlob(source.blobId));
    for (const s of deck.slides) {
      const canvas = await renderSlideToCanvas(deck, s, 1400);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.9));
      const image = blob ? await blobToImageRef(blob, s.title ?? `Slide ${s.index + 1}`) : undefined;
      blocks.push({ type: 'slide', image, anchor: { sourceId: source.id, loc: { page: s.index + 1 }, quote: s.title, createdAt: now } });
      if (s.notes?.trim()) blocks.push({ type: 'text', text: `> ${s.notes.trim().replace(/\n/g, '\n> ')}` });
      blocks.push({ type: 'ink', height: 420 });
    }
  }
  return blocks;
}
