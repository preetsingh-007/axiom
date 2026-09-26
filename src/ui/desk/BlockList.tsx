import { Fragment, memo, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type * as Y from 'yjs';
import { Plus } from 'lucide-react';
import { blockIds, blockPlainText, blockType, getBlock, insertBlock, insertBlocks, moveBlock, type NewBlock, type BlockSnapshot } from '../../core/blocks';
import { useBlockIds } from '../hooks/usePage';
import { PageEditorApi, PageEditorContext } from './editorContext';
import { BlockRow } from './BlockRow';
import { useAccordion, insertSpaceAt } from './accordion';
import { BLOCK_MIME, EXTRACT_MIME } from './dragout';
import { isTextual } from './blockActions';
import { blobToImageRef } from './blocks/imageImport';
import { useUI } from '../app/store';
import { LOCAL_ORIGIN } from '../../core/storage/docstore';
import { importFilesToLibrary } from '../library/importer';
import { EAGER_BLOCKS, blockHeights, scheduleMount, whenNearViewport } from './lazyMount';

/** Placeholder with the block's last known size until it is near the viewport or idle time mounts it. */
const LazyBlockRow = memo(function LazyBlockRow({ id, index, readOnly, showTime, doc }: { id: string; index: number; readOnly?: boolean; showTime?: boolean; doc: Y.Doc }) {
  const [mounted, setMounted] = useState(false);
  const ph = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mounted || !ph.current) return;
    const mount = () => setMounted(true);
    const offIo = whenNearViewport(ph.current, mount);
    const offIdle = scheduleMount(mount);
    return () => {
      offIo();
      offIdle();
    };
  }, [mounted]);
  if (mounted) return <BlockRow id={id} index={index} readOnly={readOnly} showTime={showTime} />;
  const type = (getBlock(doc, id)?.get('type') as string) ?? 'text';
  return <div ref={ph} className={`blk blk-ph blk-${type}`} data-block-id={id} data-block-index={index} data-block-type={type} style={{ height: blockHeights.get(id) ?? (type === 'ink' ? 300 : 34) }} />;
});

function snapshotToNew(b: BlockSnapshot): NewBlock {
  return { type: b.type, text: b.text, height: b.height, strokes: b.strokes, image: b.image, anchor: b.anchor, embed: b.embed, lang: b.lang };
}

/** Parses an extraction payload dropped from the Library. */
export function extractToBlocks(json: string): NewBlock[] {
  try {
    const data = JSON.parse(json) as { blocks: NewBlock[] };
    return data.blocks ?? [];
  } catch {
    return [];
  }
}

/**
 * The editable block list of one page: accordion gestures, drag & drop (reorder, drop from
 * Library, drop from other apps/files), and the "click below to write" tail.
 */
export const BlockList = memo(function BlockList({ doc, pageId, readOnly, showTime }: { doc: Y.Doc; pageId: string; readOnly?: boolean; showTime?: boolean }) {
  const ids = useBlockIds(doc);
  const api = useMemo(() => new PageEditorApi(pageId, doc, readOnly), [pageId, doc, readOnly]);
  const ref = useRef<HTMLDivElement>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const toast = useUI((s) => s.toast);
  useAccordion(ref, doc, !readOnly);

  const indexFromY = (clientY: number): number => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>(':scope > .blist-items > .blk') ?? [])];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return els.length;
  };

  const accepts = (e: DragEvent) => {
    const t = e.dataTransfer.types;
    return t.includes(BLOCK_MIME) || t.includes(EXTRACT_MIME) || t.includes('Files') || t.includes('text/plain');
  };

  const onDragOver = (e: DragEvent) => {
    if (readOnly || !accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(BLOCK_MIME) && !e.altKey ? 'move' : 'copy';
    const idx = indexFromY(e.clientY);
    if (idx !== dropAt) setDropAt(idx);
  };

  const onDrop = async (e: DragEvent) => {
    if (readOnly || !accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = indexFromY(e.clientY);
    setDropAt(null);
    const dt = e.dataTransfer;
    const internal = dt.getData(BLOCK_MIME);
    if (internal) {
      const { pageId: from, block } = JSON.parse(internal) as { pageId: string; block: BlockSnapshot };
      if (from === pageId && getBlock(doc, block.id)) {
        const cur = blockIds(doc).indexOf(block.id);
        moveBlock(doc, block.id, cur < idx ? idx - 1 : idx);
      } else {
        insertBlock(doc, snapshotToNew(block), idx);
      }
      return;
    }
    const extract = dt.getData(EXTRACT_MIME);
    if (extract) {
      const blocks = extractToBlocks(extract);
      if (blocks.length) insertBlocks(doc, blocks, idx);
      return;
    }
    if (dt.files.length) {
      const files = [...dt.files];
      const images = files.filter((f) => f.type.startsWith('image/'));
      const docs = files.filter((f) => !f.type.startsWith('image/'));
      const specs: NewBlock[] = [];
      for (const f of images) specs.push({ type: 'image', image: await blobToImageRef(f, f.name) });
      if (specs.length) insertBlocks(doc, specs, idx);
      if (docs.length) {
        const n = await importFilesToLibrary(docs);
        if (n) toast({ message: `Imported ${n} document${n > 1 ? 's' : ''} into the Library`, kind: 'success' });
      }
      return;
    }
    const text = dt.getData('text/plain');
    if (text) insertBlock(doc, { type: 'text', text }, idx);
  };

  const onTailClick = () => {
    if (readOnly) return;
    const cur = blockIds(doc);
    const lastId = cur[cur.length - 1];
    const last = lastId ? getBlock(doc, lastId) : undefined;
    if (last && blockType(last) === 'text' && !blockPlainText(last).trim()) {
      api.focus(lastId, 'end');
      return;
    }
    const id = insertBlock(doc, { type: 'text', text: '' }, undefined, LOCAL_ORIGIN);
    api.focus(id, 'start');
  };

  return (
    <PageEditorContext.Provider value={api}>
      <div
        ref={ref}
        className="blist"
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!ref.current?.contains(e.relatedTarget as Node)) setDropAt(null);
        }}
        onDrop={onDrop}
      >
        <div className="blist-items">
          {ids.map((id, i) => (
            <Fragment key={id}>
              {dropAt === i && <div className="blist-drop" />}
              {i < EAGER_BLOCKS ? (
                <BlockRow id={id} index={i} readOnly={readOnly} showTime={showTime} />
              ) : (
                <LazyBlockRow id={id} index={i} readOnly={readOnly} showTime={showTime} doc={doc} />
              )}
              {!readOnly && (
                <button
                  className="blk-gap-btn"
                  title="Insert whiteboard space here (or spread two fingers)"
                  aria-label="Insert whiteboard space"
                  onClick={() => insertSpaceAt(doc, i + 1)}
                  tabIndex={-1}
                >
                  <Plus size={12} />
                </button>
              )}
            </Fragment>
          ))}
          {dropAt === ids.length && <div className="blist-drop" />}
        </div>
        {!readOnly && <div className="blist-tail" onClick={onTailClick} aria-hidden />}
      </div>
    </PageEditorContext.Provider>
  );
});

export { isTextual };
