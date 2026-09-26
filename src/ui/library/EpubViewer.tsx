import { memo, useEffect, useRef, useState } from 'react';
import type { EpubBook } from '../../core/ingest/types';
import { parseEpub, epubAnchorId } from '../../core/ingest/epub';
import type { SourceLocator, SourceMeta } from '../../core/schema';
import { useServices } from '../app/services';
import { LassoOverlay } from './LassoOverlay';
import { extractFromDom, imageToBlob } from './domExtract';
import type { Extraction } from './extraction';
import type { ReaderTool } from './ReaderPane';
import { sendToDesk } from '../app/actions';
import { LRU } from '../../core/util/lru';
import { SendToBack } from 'lucide-react';

const books = new LRU<string, Promise<EpubBook>>(2, (_k, p) => {
  void p.then((b) => b.dispose()).catch(() => {});
  return true;
});

function getBook(sourceId: string, getBlob: () => Promise<Blob | undefined>) {
  let p = books.get(sourceId);
  if (!p) {
    p = getBlob().then((b) => {
      if (!b) throw new Error('File not available on this device yet');
      return parseEpub(b);
    });
    books.set(sourceId, p);
    p.catch(() => books.delete(sourceId));
  }
  return p;
}

/**
 * EPUB reader: chapters render lazily in one continuous scroll; position (chapter + fraction)
 * is remembered; lasso or select text to extract with a Wormhole anchor.
 */
export function EpubViewer({
  source,
  tool,
  jump,
  chapterJump,
  onExtract,
}: {
  source: SourceMeta;
  tool: ReaderTool;
  jump?: { loc: SourceLocator; flash?: boolean; nonce: number };
  chapterJump?: { chapter: number; fragment?: string; nonce: number };
  onExtract(ex: Extraction, anchor: DOMRect): void;
}) {
  const { vault } = useServices();
  const [book, setBook] = useState<EpubBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([vault.getViewState(source.id)?.loc.chapter ?? 0]));
  const restored = useRef(false);
  const [sel, setSel] = useState<{ text: string; chapter: number; rect: DOMRect } | null>(null);

  useEffect(() => {
    let alive = true;
    getBook(source.id, () => vault.getBlob(source.blobId))
      .then((b) => alive && setBook(b))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [source.id, source.blobId, vault]);

  const scrollToChapter = (chapter: number, offset = 0, behavior: ScrollBehavior = 'auto') => {
    setVisible((v) => new Set(v).add(chapter));
    requestAnimationFrame(() => {
      const el = scroll.current?.querySelector<HTMLElement>(`[data-chapter="${chapter}"]`);
      if (el && scroll.current) scroll.current.scrollTo({ top: el.offsetTop + offset * el.offsetHeight - 12, behavior });
    });
  };

  // restore / jump
  useEffect(() => {
    if (!book || restored.current) return;
    restored.current = true;
    if (jump?.loc.chapter !== undefined) return;
    const vs = vault.getViewState(source.id);
    if (vs?.loc.chapter !== undefined) setTimeout(() => scrollToChapter(vs.loc.chapter!, vs.intra ?? 0), 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

  useEffect(() => {
    if (!book || jump?.loc.chapter === undefined) return;
    scrollToChapter(jump.loc.chapter, jump.loc.offset ?? 0, 'smooth');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, jump?.nonce]);

  useEffect(() => {
    if (!chapterJump) return;
    scrollToChapter(chapterJump.chapter, 0);
    if (chapterJump.fragment) {
      // the chapter may still be loading: retry briefly until the anchor exists
      const id = epubAnchorId(chapterJump.chapter, chapterJump.fragment);
      let tries = 0;
      const seek = () => {
        const el = document.getElementById(id);
        if (el && scroll.current) scroll.current.scrollTo({ top: el.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top + scroll.current.scrollTop - 12 });
        else if (tries++ < 20) setTimeout(seek, 100);
      };
      setTimeout(seek, 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterJump?.nonce]);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onScroll = () => {
    const el = scroll.current;
    if (!el) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const chapters = [...el.querySelectorAll<HTMLElement>('[data-chapter]')];
      const top = el.scrollTop + 20;
      const cur = chapters.filter((c) => c.offsetTop <= top).pop() ?? chapters[0];
      if (!cur) return;
      const chapter = Number(cur.dataset.chapter);
      const intra = Math.max(0, Math.min(1, (top - cur.offsetTop) / Math.max(1, cur.offsetHeight)));
      vault.setViewState(source.id, { loc: { chapter, offset: intra }, zoom: 1, intra, updatedAt: Date.now() });
    }, 500);
  };

  const onLasso = async (poly: [number, number][], bbox: DOMRect) => {
    const chapterEl = document.elementsFromPoint(bbox.left + bbox.width / 2, bbox.top + bbox.height / 2).find((e) => (e as HTMLElement).dataset?.chapter !== undefined) as HTMLElement | undefined;
    const root = chapterEl ?? scroll.current!;
    const chapter = Number(chapterEl?.dataset.chapter ?? 0);
    const offset = chapterEl ? Math.max(0, (bbox.top - chapterEl.getBoundingClientRect().top) / chapterEl.offsetHeight) : 0;
    const res = extractFromDom(root, poly, source.id, { chapter, offset });
    const ex: Extraction = { ...res };
    if (res.images[0]) ex.image = await imageToBlob(res.images[0]);
    onExtract(ex, bbox);
  };

  // selection → quick "send to desk"
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const check = () =>
      setTimeout(() => {
        const s = window.getSelection();
        if (!s || s.isCollapsed || !s.rangeCount) return setSel(null);
        const r = s.getRangeAt(0);
        const host = (r.startContainer.parentElement as HTMLElement | null)?.closest<HTMLElement>('[data-chapter]');
        if (!host || !el.contains(host)) return setSel(null);
        setSel({ text: s.toString().trim(), chapter: Number(host.dataset.chapter), rect: r.getBoundingClientRect() });
      }, 30);
    el.addEventListener('pointerup', check);
    return () => el.removeEventListener('pointerup', check);
  }, [book]);

  if (error) return <div className="ui-empty"><h3>Couldn't open this EPUB</h3><p>{error}</p></div>;
  if (!book) return <div className="route-loading"><div className="ui-spinner" /></div>;

  return (
    <div ref={scroll} className={`epub-scroll tool-${tool}`} onScroll={onScroll}>
      <div className="epub-content">
        {book.chapters.map((c, i) => (
          <Chapter key={c.id} book={book} index={i} load={visible.has(i)} onNear={() => setVisible((v) => (v.has(i) ? v : new Set(v).add(i)))} />
        ))}
      </div>
      <LassoOverlay active={tool === 'lasso'} penLasso={tool === 'select'} target={scroll} onComplete={onLasso} />
      {sel && sel.text && (
        <button
          className="sel-float ui-btn small primary"
          style={{ left: Math.min(window.innerWidth - 150, sel.rect.left + sel.rect.width / 2 - 60), top: Math.max(60, sel.rect.top - 42) }}
          onPointerDown={(e) => e.preventDefault()}
          onClick={async () => {
            await sendToDesk([{ type: 'text', text: `> ${sel.text}`, anchor: { sourceId: source.id, loc: { chapter: sel.chapter }, quote: sel.text.slice(0, 280), createdAt: Date.now() } }]);
            window.getSelection()?.removeAllRanges();
            setSel(null);
          }}
        >
          <SendToBack size={14} /> Send to Desk
        </button>
      )}
    </div>
  );
}

const Chapter = memo(function Chapter({ book, index, load, onNear }: { book: EpubBook; index: number; load: boolean; onNear(): void }) {
  const ref = useRef<HTMLElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (load || !ref.current) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && onNear(), { rootMargin: '1200px 0px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [load, onNear]);
  useEffect(() => {
    if (!load || html !== null) return;
    let alive = true;
    book.chapterHtml(index).then((h) => alive && setHtml(h));
    return () => {
      alive = false;
    };
  }, [load, html, book, index]);
  return (
    <section ref={ref} className="epub-chapter" data-chapter={index} style={html === null ? { minHeight: 900 } : undefined}>
      {html !== null ? <div className="epub-html" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="epub-ph" />}
    </section>
  );
});
