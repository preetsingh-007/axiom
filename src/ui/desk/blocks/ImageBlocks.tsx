/**
 * Image and slide blocks: resizable photos with ink annotations.
 *
 *  - drag the corner handle to resize (snaps to ¼, ½, ¾ and full width; double-click resets;
 *    arrow keys on the handle step by 5%); the width is stored as a fraction of the column;
 *  - "Annotate" opens the photo in the zoomable focus view to draw, highlight and write on it;
 *    in the note the annotations are drawn over the photo and can be hidden.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Eye, EyeOff, PenLine } from 'lucide-react';
import { blockAnchor, blockBeautified, blockDisplayWidth, blockImage, blockLabelList, blockStrokes, blockText, type BlockMap } from '../../../core/blocks';
import { INK_LOGICAL_WIDTH } from '../../../core/schema';
import { inkToSvg } from '../../../core/ink/render';
import { LOCAL_ORIGIN } from '../../../core/storage/docstore';
import { useBlobUrl, useYText } from '../../hooks/usePage';
import { useYSelect, useYDeep } from '../../hooks/useY';
import { renderSourcePage } from '../../library/pdfCache';
import { LabelView } from '../../ink/InkCanvas';
import { openFocus, type FocusPhoto } from '../../ink/focusStore';

/** Smallest image width when resizing (CSS px). */
const MIN_PX = 64;
const SNAPS = [0.25, 0.5, 0.75, 1];

/** Snaps a width fraction to ¼ steps when within 2%, clamped to [min, 1]. */
export function snapWidth(frac: number, min = 0.1): number {
  const f = Math.max(min, Math.min(1, frac));
  for (const s of SNAPS) if (Math.abs(f - s) < 0.02) return s;
  return Math.round(f * 1000) / 1000;
}

function transact(block: BlockMap, fn: () => void) {
  if (block.doc) block.doc.transact(fn, LOCAL_ORIGIN);
  else fn();
}

export function setImageWidth(block: BlockMap, frac: number | null) {
  transact(block, () => {
    if (frac === null || frac >= 1 - 1e-6) block.delete('displayWidth');
    else block.set('displayWidth', frac);
  });
}

export function toggleAnnotations(block: BlockMap) {
  transact(block, () => {
    if (block.get('annotationsHidden') === true) block.delete('annotationsHidden');
    else block.set('annotationsHidden', true);
  });
}

export function hasAnnotations(b: BlockMap): boolean {
  return (blockStrokes(b)?.length ?? 0) > 0 || blockLabelList(b).length > 0;
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((e) => setW(e[e.length - 1]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Annotations drawn over a photo in the note (static; editing happens in the focus view). */
export function AnnotationLayer({ block, aspect }: { block: BlockMap; aspect: number }) {
  useYDeep(block);
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const strokes = blockStrokes(block)?.toArray() ?? [];
  const beautified = blockBeautified(block);
  const labels = blockLabelList(block);
  const h = INK_LOGICAL_WIDTH / aspect;
  const svg = useMemo(() => (strokes.length || beautified ? inkToSvg(strokes, beautified, INK_LOGICAL_WIDTH, h, { inkColor: '#1d2230' }) : ''), [strokes, beautified, h]);
  const scale = (width || INK_LOGICAL_WIDTH) / INK_LOGICAL_WIDTH;
  return (
    <div ref={ref} className="blk-annot" aria-hidden="true">
      {svg && <div className="blk-annot-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
      {labels.map((l) => (
        <LabelView key={l.id} label={l} scale={scale} />
      ))}
    </div>
  );
}

function ImageTools({ block, photo, title }: { block: BlockMap; photo: FocusPhoto | null; title: string }) {
  const annotated = useYSelect(block, (b) => hasAnnotations(b), { deep: true });
  const hidden = useYSelect(block, (b) => b.get('annotationsHidden') === true);
  if (!photo) return null;
  return (
    <div className="blk-image-tools">
      <button type="button" className="blk-image-tool" onClick={() => openFocus({ block, kind: 'photo', image: photo, title })} title="Draw and write on this picture (zoomable)">
        <PenLine size={14} aria-hidden="true" />
        <span>Annotate</span>
      </button>
      {annotated && (
        <button
          type="button"
          className="blk-image-tool"
          onClick={() => toggleAnnotations(block)}
          aria-pressed={hidden}
          aria-label={hidden ? 'Show annotations' : 'Hide annotations'}
          title={hidden ? 'Show annotations' : 'Hide annotations'}
        >
          {hidden ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

/** Corner handle that resizes the frame; commits the width fraction on release. */
function ResizeHandle({ block, frameRef, figRef }: { block: BlockMap; frameRef: React.RefObject<HTMLDivElement | null>; figRef: React.RefObject<HTMLElement | null> }) {
  const drag = useRef<{ id: number; x0: number; w0: number; full: number; frac: number; moved: boolean; style: string } | null>(null);
  /** last tap on the handle (double-tap resets; dblclick is unreliable once pointerdown is handled) */
  const lastTap = useRef(0);
  const current = useYSelect(block, (b) => blockDisplayWidth(b));

  const onDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const frame = frameRef.current;
    const fig = figRef.current;
    if (!frame || !fig || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    const full = fig.getBoundingClientRect().width || 1;
    const w0 = frame.getBoundingClientRect().width;
    drag.current = { id: e.pointerId, x0: e.clientX, w0, full, frac: w0 / full, moved: false, style: frame.style.width };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic */
    }
    frame.classList.add('resizing');
  };
  const onMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    const frame = frameRef.current;
    if (!d || d.id !== e.pointerId || !frame) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    d.moved = true;
    const px = Math.max(MIN_PX, Math.min(d.full, d.w0 + (e.clientX - d.x0)));
    d.frac = snapWidth(px / d.full, MIN_PX / d.full);
    frame.style.width = `${d.frac * 100}%`;
  };
  const finish = (e: ReactPointerEvent<HTMLSpanElement>, commit: boolean) => {
    const d = drag.current;
    const frame = frameRef.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    frame?.classList.remove('resizing');
    // back to the width React rendered; a committed change re-renders with the new one
    if (frame && d.moved) frame.style.width = d.style;
    if (!d.moved) {
      if (commit && e.timeStamp - lastTap.current < 400) {
        lastTap.current = 0;
        setImageWidth(block, null);
      } else lastTap.current = e.timeStamp;
      return;
    }
    lastTap.current = 0;
    if (commit && Math.abs(d.frac - d.w0 / d.full) > 0.002) setImageWidth(block, d.frac);
  };
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const fig = figRef.current;
    const frame = frameRef.current;
    if (!fig || !frame) return;
    const cur = current ?? frame.getBoundingClientRect().width / (fig.getBoundingClientRect().width || 1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setImageWidth(block, snapWidth(cur - 0.05));
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setImageWidth(block, snapWidth(cur + 0.05));
    else if (e.key === 'Home') setImageWidth(block, 0.25);
    else if (e.key === 'End') setImageWidth(block, null);
    else return;
    e.preventDefault();
  };
  const pct = Math.round((current ?? 1) * 100);
  return (
    <span
      className="blk-image-resize"
      role="slider"
      tabIndex={0}
      aria-label="Image width"
      aria-valuemin={10}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={current ? `${pct}% of the column` : 'Original size'}
      title="Drag to resize · double-click to reset"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
      onDoubleClick={() => setImageWidth(block, null)}
      onKeyDown={onKey}
    />
  );
}

interface FrameProps {
  block: BlockMap;
  readOnly?: boolean;
  src: string | undefined;
  alt: string;
  /** natural size (0 when unknown) */
  w: number;
  h: number;
  /** cap for the natural display width (CSS px) */
  maxNatural?: number;
  /** full column width by default (slides) */
  fill?: boolean;
  placeholderRatio?: string;
  imgClass?: string;
  focusImage: FocusPhoto | null;
  title: string;
}

/** A picture with optional annotations, resize handle and tools. */
function PictureFrame({ block, readOnly, src, alt, w, h, maxNatural = 1400, fill, placeholderRatio, imgClass, focusImage, title }: FrameProps) {
  // the anchor spans the whole column: resizing measures against it
  const figRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const displayWidth = useYSelect(block, (b) => blockDisplayWidth(b));
  const annotated = useYSelect(block, (b) => hasAnnotations(b), { deep: true });
  const hidden = useYSelect(block, (b) => b.get('annotationsHidden') === true);
  const known = w > 0 && h > 0;
  const ratio = known ? `${w} / ${h}` : undefined;
  const width = displayWidth !== undefined ? `${displayWidth * 100}%` : fill ? '100%' : known ? `${Math.min(w, maxNatural)}px` : undefined;
  return (
    <div ref={figRef} className="blk-image-anchor">
      <div ref={frameRef} className={`blk-image-frame${displayWidth !== undefined ? ' sized' : ''}${width ? '' : ' natural'}`} style={{ width }}>
        {src ? (
          <img className={imgClass} src={src} alt={alt} style={{ aspectRatio: ratio }} draggable={false} loading="lazy" decoding="async" />
        ) : (
          <div className="blk-image-ph" style={{ aspectRatio: ratio ?? placeholderRatio ?? '4 / 3' }} />
        )}
        {src && known && annotated && !hidden && <AnnotationLayer block={block} aspect={w / h} />}
        {!readOnly && src && <ImageTools block={block} photo={focusImage} title={title} />}
        {!readOnly && <ResizeHandle block={block} frameRef={frameRef} figRef={figRef} />}
      </div>
    </div>
  );
}

export const ImageBlock = memo(function ImageBlock({ block, readOnly }: { block: BlockMap; readOnly?: boolean }) {
  const image = useYSelect(block, (b) => blockImage(b));
  const url = useBlobUrl(image?.blobId);
  const caption = useYText(blockText(block));
  if (!image) return null;
  const known = image.w > 0 && image.h > 0;
  return (
    <figure className="blk-image-fig">
      <PictureFrame
        block={block}
        readOnly={readOnly}
        src={url}
        alt={image.alt ?? caption ?? ''}
        w={image.w}
        h={image.h}
        focusImage={known ? { blobId: image.blobId, w: image.w, h: image.h } : null}
        title={caption || image.alt || 'Annotate photo'}
      />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
});

/** A slide/page of a source, rendered on demand from the original file (no duplicate storage). */
export const SlideBlock = memo(function SlideBlock({ block, readOnly }: { block: BlockMap; readOnly?: boolean }) {
  const anchor = useYSelect(block, (b) => blockAnchor(b));
  const image = useYSelect(block, (b) => blockImage(b));
  const stored = useBlobUrl(image?.blobId);
  const [rendered, setRendered] = useState<{ url: string; w: number; h: number }>();
  useEffect(() => {
    if (image || !anchor?.loc.page) return;
    let alive = true;
    renderSourcePage(anchor.sourceId, anchor.loc.page, 1400).then((r) => {
      if (!alive || !r) return;
      setRendered({ url: r.url, w: r.width, h: r.height });
    });
    return () => {
      alive = false;
    };
  }, [anchor?.sourceId, anchor?.loc.page, image]);
  const src = stored ?? rendered?.url;
  const w = image?.w || rendered?.w || 0;
  const h = image?.h || rendered?.h || 0;
  const focusImage: FocusPhoto | null = src && w > 0 && h > 0 ? (image?.blobId && stored ? { blobId: image.blobId, w, h } : { url: src, w, h }) : null;
  return (
    <figure className="blk-slide-fig">
      <PictureFrame
        block={block}
        readOnly={readOnly}
        src={src}
        alt={`Slide ${anchor?.loc.page ?? ''}`}
        w={w}
        h={h}
        fill
        placeholderRatio="16 / 9"
        imgClass="blk-slide-img"
        focusImage={focusImage}
        title={`Slide ${anchor?.loc.page ?? ''}`.trim()}
      />
    </figure>
  );
});
