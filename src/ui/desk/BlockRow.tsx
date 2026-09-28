import { memo, useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { GripVertical, Anchor as AnchorIcon, Type, Sigma, Code2, PenLine, Copy, FileCode2, Trash2, Layers, CopyPlus, BookOpen } from 'lucide-react';
import { blockAnchor, blockType, getBlock, snapshotBlock, insertBlockAfter, blockPlainText } from '../../core/blocks';
import type { BlockType } from '../../core/schema';
import { usePageEditor } from './editorContext';
import { useYSelect } from '../hooks/useY';
import { TextBlock } from './blocks/TextBlock';
import { MathBlock, CodeBlock, ImageBlock, SlideBlock, EmbedBlock } from './blocks/OtherBlocks';
import { InkBlock } from './blocks/InkBlock';
import { Menu, type MenuItem } from '../components/Menu';
import { blockActions } from './blockActions';
import { useUI } from '../app/store';
import { blockHeights } from './lazyMount';
import { blockDragPayload, BLOCK_MIME, copyText, exportBlock } from './dragout';

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * One block: gutter (drag handle / menu), content by type, and the Wormhole anchor.
 */
export const BlockRow = memo(function BlockRow({ id, index, compact, readOnly, showTime }: { id: string; index: number; compact?: boolean; readOnly?: boolean; showTime?: boolean }) {
  const api = usePageEditor()!;
  const doc = api.doc;
  const block = getBlock(doc, id);
  const type = useYSelect(block, (b) => blockType(b)) as BlockType | undefined;
  const anchor = useYSelect(block, (b) => blockAnchor(b));
  const openReader = useUI((s) => s.openReader);
  const toast = useUI((s) => s.toast);
  const isFlashcard = useYSelect(block, (b) => /#flashcard\b/i.test(blockPlainText(b)), { deep: true });
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rowRef.current;
    return () => {
      if (el?.offsetHeight) blockHeights.set(id, el.offsetHeight);
    };
  }, [id]);

  const onDragStart = useCallback(
    (e: DragEvent) => {
      if (!block) return;
      const payload = blockDragPayload(api.pageId, snapshotBlock(block));
      for (const [mime, data] of Object.entries(payload)) e.dataTransfer.setData(mime, data);
      e.dataTransfer.effectAllowed = 'copyMove';
      const row = (e.currentTarget as HTMLElement).closest('.blk') as HTMLElement | null;
      if (row) e.dataTransfer.setDragImage(row, 12, 12);
    },
    [api.pageId, block],
  );

  if (!block || !type) return null;
  const actions = blockActions(api, id);

  const menu = (): MenuItem[] => {
    const snap = snapshotBlock(block);
    const items: MenuItem[] = [];
    const turn = (t: BlockType, label: string, icon: React.ReactNode) =>
      items.push({ label, icon, run: () => actions.convert(t), disabled: type === t });
    if (type === 'text' || type === 'math' || type === 'code') {
      turn('text', 'Turn into text', <Type size={15} />);
      turn('math', 'Turn into equation', <Sigma size={15} />);
      turn('code', 'Turn into code', <Code2 size={15} />);
      items.push({ separator: true, label: '' });
    }
    items.push(
      { label: 'Add whiteboard below', icon: <PenLine size={15} />, run: () => actions.insertAfter({ type: 'ink', height: 360 }, false) },
      { label: 'Copy as Markdown', icon: <Copy size={15} />, run: () => copyText(exportBlock(snap, 'md')).then(() => toast({ message: 'Copied Markdown' })) },
      { label: 'Copy as LaTeX', icon: <FileCode2 size={15} />, run: () => copyText(exportBlock(snap, 'tex')).then(() => toast({ message: 'Copied LaTeX' })) },
    );
    if (type === 'text') {
      items.push({
        label: isFlashcard ? 'Remove from flashcards' : 'Make flashcard',
        icon: <Layers size={15} />,
        run: () => {
          const t = block.get('text') as import('yjs').Text;
          const s = t.toString();
          if (isFlashcard) {
            const m = /\s*#flashcard\b/i.exec(s);
            if (m) doc.transact(() => t.delete(m.index, m[0].length));
          } else actions.appendText('#flashcard');
        },
      });
    }
    items.push({
      label: 'Duplicate',
      icon: <CopyPlus size={15} />,
      run: () =>
        insertBlockAfter(doc, id, {
          type: snap.type,
          text: snap.text,
          height: snap.height,
          strokes: snap.strokes,
          image: snap.image,
          anchor: snap.anchor,
          embed: snap.embed,
        }),
    });
    if (anchor) items.push({ label: 'Open source', icon: <BookOpen size={15} />, run: () => openReader(anchor.sourceId, { loc: anchor.loc, flash: true }) });
    items.push({ separator: true, label: '' }, { label: 'Delete', icon: <Trash2 size={15} />, danger: true, hint: '', run: () => actions.remove() });
    return items;
  };

  let content: React.ReactNode;
  switch (type) {
    case 'text':
      content = <TextBlock block={block} id={id} readOnly={readOnly} />;
      break;
    case 'math':
      content = <MathBlock block={block} id={id} readOnly={readOnly} />;
      break;
    case 'code':
      content = <CodeBlock block={block} id={id} readOnly={readOnly} />;
      break;
    case 'image':
      content = <ImageBlock block={block} />;
      break;
    case 'slide':
      content = <SlideBlock block={block} />;
      break;
    case 'embed':
      content = <EmbedBlock block={block} />;
      break;
    case 'ink':
      content = <InkBlock block={block} id={id} readOnly={readOnly} />;
      break;
    default:
      content = null;
  }

  const created = block.get('createdAt') as number | undefined;

  return (
    <div ref={rowRef} className={`blk blk-${type}${compact ? ' blk-compact' : ''}${isFlashcard ? ' blk-is-card' : ''}`} data-block-id={id} data-block-index={index} data-block-type={type}>
      {!readOnly && (
        <div className="blk-gutter">
          <div
            className="blk-handle"
            role="button"
            tabIndex={-1}
            draggable
            onDragStart={onDragStart}
            title="Drag to move · click for options"
            aria-label="Block options"
            aria-haspopup="menu"
            data-drag-handle
            onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)}
          >
            <GripVertical size={15} />
          </div>
          {menuAnchor && <Menu anchor={menuAnchor} items={menu()} onClose={() => setMenuAnchor(null)} />}
        </div>
      )}
      {showTime && created ? (
        <time className="blk-time" dateTime={new Date(created).toISOString()} title={new Date(created).toLocaleString()}>
          {formatTime(created)}
        </time>
      ) : null}
      <div className="blk-body">{content}</div>
      <div className="blk-aside">
        {anchor && (
          <button
            className="blk-anchor"
            title={`Wormhole: open source${anchor.loc.page ? ` at p. ${anchor.loc.page}` : ''}${anchor.quote ? `\n“${anchor.quote.slice(0, 120)}”` : ''}`}
            aria-label="Open source location"
            onClick={() => openReader(anchor.sourceId, { loc: anchor.loc, flash: true })}
          >
            <AnchorIcon size={14} />
          </button>
        )}
      </div>
    </div>
  );
});

export { BLOCK_MIME };
