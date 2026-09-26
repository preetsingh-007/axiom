import { blockPlainText, blockType, getBlock, insertBlockAfter, deleteBlock, blockIds, insertBlock } from '../../../core/blocks';
import type { PageEditorApi } from '../editorContext';
import type { ImageRef } from '../../../core/schema';
import { getServicesUnsafe } from '../../app/servicesRef';
import { LOCAL_ORIGIN } from '../../../core/storage/docstore';

export async function imageSize(blob: Blob): Promise<{ w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const s = { w: bmp.width, h: bmp.height };
    bmp.close();
    return s;
  } catch {
    return { w: 0, h: 0 };
  }
}

export async function blobToImageRef(blob: Blob, alt?: string): Promise<ImageRef> {
  const { vault } = getServicesUnsafe();
  const blobId = await vault.putBlob(blob);
  const { w, h } = await imageSize(blob);
  return { blobId, w, h, alt, mime: blob.type };
}

/** Stores an image file and inserts an image block after (or in place of an empty) block. */
export async function importImageBlock(api: PageEditorApi, afterId: string, file: Blob) {
  const image = await blobToImageRef(file, (file as File).name);
  const doc = api.doc;
  const cur = getBlock(doc, afterId);
  if (cur && blockType(cur) === 'text' && !blockPlainText(cur).trim()) {
    const idx = blockIds(doc).indexOf(afterId);
    doc.transact(() => {
      deleteBlock(doc, afterId);
      insertBlock(doc, { type: 'image', image }, idx);
    }, LOCAL_ORIGIN);
  } else {
    insertBlockAfter(doc, afterId, { type: 'image', image });
  }
}
