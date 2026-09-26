import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { X, ListTree, ZoomIn, ZoomOut, MousePointer2, Lasso, Presentation, Maximize2, BookMarked } from 'lucide-react';
import { useUI } from '../app/store';
import { useServices } from '../app/services';
import { useYSelect } from '../hooks/useY';
import type { SourceMeta, TocEntry, Highlight } from '../../core/schema';
import { PdfViewer } from './PdfViewer';
import { ExtractCard } from './ExtractCard';
import { SelectionMenu, type SelectionInfo } from './SelectionMenu';
import type { Extraction } from './extraction';
import { sendToDesk, resolvePage } from '../app/actions';
import { uid } from '../../core/util/ids';
import { createSeminarNotebook } from './seminar';

const EpubViewer = lazy(() => import('./EpubViewer').then((m) => ({ default: m.EpubViewer })));
const PptxViewer = lazy(() => import('./PptxViewer').then((m) => ({ default: m.PptxViewer })));

export type ReaderTool = 'select' | 'lasso';

/** The Source Vault reader: pristine document + TOC tree + lasso & highlight tools. */
export function ReaderPane() {
  const { vault } = useServices();
  const reader = useUI((s) => s.reader)!;
  const closeReader = useUI((s) => s.closeReader);
  const openSideQuest = useUI((s) => s.openSideQuest);
  const navigate = useUI((s) => s.navigate);
  const toast = useUI((s) => s.toast);
  const source = useYSelect(vault.sources.get(reader.sourceId), (m) => m.toJSON() as SourceMeta, { deep: true });
  const [tocOpen, setTocOpen] = useState(() => window.innerWidth > 1300);
  const [zoom, setZoom] = useState(() => vault.getViewState(reader.sourceId)?.zoom ?? 1);
  const [tool, setTool] = useState<ReaderTool>('select');
  const [page, setPage] = useState(1);
  const [extract, setExtract] = useState<{ ex: Extraction; anchor: DOMRect; nonce: number } | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [goto, setGoto] = useState<{ page: number; nonce: number } | undefined>();
  const [chapterJump, setChapterJump] = useState<{ chapter: number; fragment?: string; nonce: number } | undefined>();

  const onExtract = useCallback((ex: Extraction, anchor: DOMRect) => setExtract({ ex, anchor, nonce: Date.now() }), []);
  const onZoom = useCallback((z: number) => setZoom(Math.round(z * 100) / 100), []);

  const highlight = (color: string) => {
    if (!selection || !source) return;
    const h: Highlight = { id: uid(8), sourceId: source.id, loc: selection.loc, rects: selection.rects, color, text: selection.text, createdAt: Date.now() };
    const arr = vault.highlightsFor(source.id);
    vault.transact(() => arr.push([h]));
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  const sendSelection = async () => {
    if (!selection || !source) return;
    await sendToDesk([{ type: 'text', text: `> ${selection.text}`, anchor: { sourceId: source.id, loc: selection.loc, quote: selection.text.slice(0, 280), createdAt: Date.now() } }]);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  const lookup = () => {
    if (!selection) return;
    const term = selection.text.length > 80 ? selection.text.slice(0, 80) : selection.text;
    openSideQuest(resolvePage(term.replace(/[.,;:]+$/, '')));
    setSelection(null);
  };

  const tocJump = (e: TocEntry) => {
    if (e.page) setGoto({ page: e.page, nonce: Date.now() });
    if (e.chapter !== undefined) setChapterJump({ chapter: e.chapter, fragment: (e as TocEntry & { fragment?: string }).fragment, nonce: Date.now() });
  };

  const seminar = async () => {
    if (!source) return;
    const id = await createSeminarNotebook(source);
    navigate({ name: 'page', pageId: id });
    toast({ message: 'Seminar notebook ready — whiteboard space under every slide', kind: 'success' });
  };

  const tocItems = useMemo(() => source?.toc ?? [], [source?.toc]);

  if (!source) {
    return (
      <div className="ui-empty">
        <h3>Source not found</h3>
        <button className="ui-btn" onClick={closeReader}>
          Close
        </button>
      </div>
    );
  }

  const isPdf = source.kind === 'pdf';

  return (
    <div className={`reader${tocOpen ? ' toc-open' : ''}`}>
      <div className="reader-bar">
        <button className="ui-icon-btn" aria-pressed={tocOpen} onClick={() => setTocOpen(!tocOpen)} title="Table of contents" aria-label="Toggle table of contents">
          <ListTree size={17} />
        </button>
        <div className="reader-title" title={source.title}>
          <span className="reader-title-text">{source.title}</span>
          {source.bib?.bibKey && <span className="reader-bibkey">@{source.bib.bibKey}</span>}
        </div>
        {isPdf && source.pageCount && (
          <span className="reader-page" aria-live="polite">
            {page} / {source.pageCount}
          </span>
        )}
        <div className="reader-tools" role="toolbar" aria-label="Reader tools">
          <button className="ui-icon-btn" aria-pressed={tool === 'select'} onClick={() => setTool('select')} title="Select & highlight text" aria-label="Select tool">
            <MousePointer2 size={16} />
          </button>
          <button className="ui-icon-btn" aria-pressed={tool === 'lasso'} onClick={() => setTool(tool === 'lasso' ? 'select' : 'lasso')} title="Lasso: extract text, equations or figures (stylus & Alt+drag always lasso)" aria-label="Lasso tool">
            <Lasso size={16} />
          </button>
          {isPdf && (
            <>
              <span className="reader-sep" />
              <button className="ui-icon-btn" onClick={() => onZoom(Math.max(0.4, zoom / 1.15))} aria-label="Zoom out" title="Zoom out">
                <ZoomOut size={16} />
              </button>
              <button className="reader-zoom" onClick={() => onZoom(1)} title="Fit width">
                {Math.round(zoom * 100)}%
              </button>
              <button className="ui-icon-btn" onClick={() => onZoom(Math.min(4, zoom * 1.15))} aria-label="Zoom in" title="Zoom in">
                <ZoomIn size={16} />
              </button>
            </>
          )}
          {(source.isSlides || source.kind === 'pptx') && (
            <button className="ui-btn small" onClick={seminar} title="Stack slides vertically with whiteboard space under each">
              <Presentation size={14} /> Seminar notebook
            </button>
          )}
          <button className="ui-icon-btn" onClick={() => useUI.getState().setSplitRatio(useUI.getState().splitRatio > 0.6 ? 0.5 : 0.72)} title="Widen reader" aria-label="Widen reader">
            <Maximize2 size={15} />
          </button>
          <button className="ui-icon-btn" onClick={closeReader} title="Close source" aria-label="Close source">
            <X size={17} />
          </button>
        </div>
      </div>
      <div className="reader-body">
        {tocOpen && (
          <nav className="toc" aria-label="Table of contents">
            {tocItems.length === 0 ? (
              <div className="toc-empty">
                <BookMarked size={16} />
                No table of contents in this file
              </div>
            ) : (
              <TocTree items={tocItems} onJump={tocJump} current={page} />
            )}
          </nav>
        )}
        <div className="reader-view">
          {source.kind === 'pdf' && (
            <PdfViewer
              source={source}
              zoom={zoom}
              tool={tool}
              jump={reader.jump}
              onExtract={onExtract}
              onSelection={setSelection}
              onPageChange={setPage}
              onZoom={onZoom}
              scrollToPage={goto}
            />
          )}
          <Suspense fallback={<div className="route-loading"><div className="ui-spinner" /></div>}>
            {source.kind === 'epub' && <EpubViewer source={source} tool={tool} jump={reader.jump} chapterJump={chapterJump} onExtract={onExtract} />}
            {source.kind === 'pptx' && <PptxViewer source={source} tool={tool} jump={reader.jump} onExtract={onExtract} />}
          </Suspense>
        </div>
      </div>
      {extract && <ExtractCard key={extract.nonce} ex={extract.ex} anchor={extract.anchor} onClose={() => setExtract(null)} />}
      {selection && !extract && <SelectionMenu info={selection} onHighlight={highlight} onSend={sendSelection} onLookup={lookup} onClose={() => setSelection(null)} />}
    </div>
  );
}

function TocTree({ items, onJump, current, depth = 0 }: { items: TocEntry[]; onJump(e: TocEntry): void; current: number; depth?: number }) {
  return (
    <ul className="toc-list" style={{ ['--depth' as string]: depth }}>
      {items.map((e, i) => (
        <TocNode key={i} e={e} onJump={onJump} current={current} depth={depth} />
      ))}
    </ul>
  );
}

function TocNode({ e, onJump, current, depth }: { e: TocEntry; onJump(e: TocEntry): void; current: number; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const has = !!e.children?.length;
  return (
    <li>
      <div className={`toc-item${e.page === current ? ' current' : ''}`}>
        {has ? (
          <button className="toc-caret" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="toc-caret" />
        )}
        <button className="toc-link" onClick={() => onJump(e)} title={e.title}>
          <span className="toc-text">{e.title}</span>
          {e.page !== undefined && <span className="toc-page">{e.page}</span>}
        </button>
      </div>
      {has && open && <TocTree items={e.children!} onJump={onJump} current={current} depth={depth + 1} />}
    </li>
  );
}
