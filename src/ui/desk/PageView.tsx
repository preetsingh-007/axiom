import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Download, FileCode2, Trash2, BookOpen, Network, Copy } from 'lucide-react';
import { useServices } from '../app/services';
import { usePageDoc, usePageMeta } from '../hooks/usePage';
import { BlockList } from './BlockList';
import { MenuButton, type MenuItem } from '../components/Menu';
import { useUI } from '../app/store';
import { snapshotPage } from '../../core/blocks';
import { pageToLatex, pageToMarkdown } from '../../core/export/markdown';
import { formatDateLong } from '../../core/util/ids';
import { copyText } from './dragout';
import { downloadText } from '../util/download';
import { Backlinks } from './Backlinks';
import { inkSvgForExport } from './blocks/InkBlock';
import { renamePageEverywhere } from '../app/actions';

const KIND_LABEL: Record<string, string> = { daily: 'Daily note', note: 'Note', concept: 'Concept', seminar: 'Seminar notebook', sidequest: 'Side quest' };

/** A full page on the Desk: title, blocks, backlinks. */
export function PageView({ pageId, compact, blockId }: { pageId: string; compact?: boolean; blockId?: string }) {
  const { vault } = useServices();
  const meta = usePageMeta(pageId);
  const doc = usePageDoc(pageId);
  const navigate = useUI((s) => s.navigate);
  const openReader = useUI((s) => s.openReader);
  const toast = useUI((s) => s.toast);

  useEffect(() => {
    if (doc) vault.ensureNonEmpty(doc);
  }, [doc, vault]);

  // deep link to a block: scroll to it and flash it
  useEffect(() => {
    if (!doc || !blockId) return;
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-page-id="${pageId}"] [data-block-id="${blockId}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('blk-flash');
      setTimeout(() => el.classList.remove('blk-flash'), 2200);
    }, 80);
    return () => clearTimeout(t);
  }, [doc, blockId, pageId]);

  // bump updatedAt on edits (throttled inside touchPage)
  useEffect(() => {
    if (!doc) return;
    const fn = (_u: Uint8Array, origin: unknown) => {
      if (origin && typeof origin === 'object' && 'transport' in origin) return;
      vault.touchPage(pageId);
    };
    doc.on('update', fn);
    return () => doc.off('update', fn);
  }, [doc, vault, pageId]);

  if (!meta) {
    return (
      <div className="ui-empty">
        <h3>Page not found</h3>
        <p>It may have been deleted, or it hasn't synced to this device yet.</p>
        <button className="ui-btn" onClick={() => navigate({ name: 'stream' })}>
          Go to today
        </button>
      </div>
    );
  }

  const exportCtx = { source: (id: string) => vault.getSource(id), inkToSvg: inkSvgForExport };
  const menu = (): MenuItem[] => [
    { label: 'Copy page as Markdown', icon: <Copy size={15} />, run: () => doc && copyText(pageToMarkdown(meta.title, snapshotPage(doc), exportCtx)).then(() => toast({ message: 'Copied Markdown' })) },
    { label: 'Export Markdown (.md)', icon: <Download size={15} />, run: () => doc && downloadText(`${meta.title}.md`, pageToMarkdown(meta.title, snapshotPage(doc), exportCtx), 'text/markdown') },
    { label: 'Export LaTeX (.tex)', icon: <FileCode2 size={15} />, run: () => doc && downloadText(`${meta.title}.tex`, pageToLatex(meta.title, snapshotPage(doc), exportCtx), 'application/x-tex') },
    { label: 'Show in graph', icon: <Network size={15} />, run: () => navigate({ name: 'graph', focus: pageId }) },
    ...(meta.sourceId ? [{ label: 'Open source deck', icon: <BookOpen size={15} />, run: () => openReader(meta.sourceId!) }] : []),
    ...(meta.kind !== 'daily'
      ? [
          { separator: true, label: '' },
          {
            label: 'Delete page',
            icon: <Trash2 size={15} />,
            danger: true,
            run: () => {
              vault.trashPage(pageId);
              navigate({ name: 'stream' });
              toast({ message: `Deleted “${meta.title}”`, action: { label: 'Undo', run: () => vault.updatePage(pageId, { trashed: undefined }) } });
            },
          },
        ]
      : []),
  ];

  return (
    <article className={`page${compact ? ' page-compact' : ''}`} data-page-id={pageId}>
      <header className="page-head">
        <div className="page-kind">{KIND_LABEL[meta.kind] ?? 'Page'}</div>
        <div className="page-title-row">
          <PageTitle pageId={pageId} title={meta.kind === 'daily' && meta.date ? formatDateLong(meta.date) : meta.title} editable={meta.kind !== 'daily'} />
          <MenuButton items={menu} title="Page options" align="end">
            <MoreHorizontal size={18} />
          </MenuButton>
        </div>
      </header>
      {doc ? <BlockList doc={doc} pageId={pageId} /> : <div className="page-loading" />}
      {!compact && <Backlinks pageId={pageId} />}
    </article>
  );
}

function PageTitle({ pageId, title, editable }: { pageId: string; title: string; editable: boolean }) {
  const [draft, setDraft] = useState(title);
  const ref = useRef<HTMLHeadingElement>(null);
  const editingRef = useRef(false);
  useEffect(() => {
    if (!editingRef.current) setDraft(title);
  }, [title]);
  if (!editable) return <h1 className="page-title">{title}</h1>;
  const commit = () => {
    editingRef.current = false;
    const next = (ref.current?.textContent ?? '').trim();
    if (next && next !== title) void renamePageEverywhere(pageId, next);
    else if (ref.current) ref.current.textContent = title;
  };
  return (
    <h1
      ref={ref}
      className="page-title editable"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onFocus={() => (editingRef.current = true)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLElement).blur();
        } else if (e.key === 'Escape') {
          (e.target as HTMLElement).textContent = title;
          (e.target as HTMLElement).blur();
        }
      }}
    >
      {draft}
    </h1>
  );
}
