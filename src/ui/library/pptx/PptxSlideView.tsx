/**
 * Renders a parsed PPTX slide: a slide-sized box (deck px) with absolutely
 * positioned elements, scaled to the requested CSS width with a transform, so
 * text keeps the deck's sizes and wrapping at every zoom level.
 *
 * Also exports `renderSlideToCanvas` (images for seminar notebooks/thumbnails).
 */
import type { CSSProperties, ReactNode } from 'react';
import type { PptxDeck, PptxElement, PptxParagraph, PptxSlide } from '../../../core/ingest/types';
import {
  DEFAULT_BG,
  DEFAULT_TEXT,
  INSET_X,
  INSET_Y,
  LEVEL_INDENT,
  LINE_HEIGHT,
  PT_TO_PX,
  SLIDE_FONT,
  bulletLabels,
  isLineGeom,
  shapePath,
} from './geometry';
import './PptxSlideView.css';

export { renderSlideToCanvas, renderSlideToBlob } from './canvas';

export interface PptxSlideViewProps {
  deck: PptxDeck;
  slide: PptxSlide;
  /** rendered CSS width in px; height follows the deck aspect ratio */
  width: number;
  className?: string;
  /** accessible label (defaults to the slide title) */
  label?: string;
}

function boxStyle(e: PptxElement): CSSProperties {
  const s: CSSProperties = { left: e.x, top: e.y, width: Math.max(e.w, 0), height: Math.max(e.h, 0) };
  if (e.rotation) s.transform = `rotate(${e.rotation}deg)`;
  return s;
}

function ShapeSvg({ geom, w, h, fill, stroke, strokeWidth }: { geom: string; w: number; h: number; fill?: string; stroke?: string; strokeWidth?: number }) {
  const line = isLineGeom(geom);
  const sw = strokeWidth ?? (stroke || line ? 1.5 : 0);
  const pad = Math.ceil(sw);
  const d = shapePath(geom, w, h);
  return (
    <svg
      className="pptx-shape-svg"
      width={Math.max(w, 1) + pad * 2}
      height={Math.max(h, 1) + pad * 2}
      viewBox={`${-pad} ${-pad} ${Math.max(w, 1) + pad * 2} ${Math.max(h, 1) + pad * 2}`}
      style={{ left: -pad, top: -pad }}
      aria-hidden="true"
    >
      {d ? (
        <path d={d} fill={line ? 'none' : (fill ?? 'none')} stroke={stroke ?? (line ? DEFAULT_TEXT : 'none')} strokeWidth={sw} />
      ) : (
        <rect x={0} y={0} width={w} height={h} fill={fill ?? 'none'} stroke={stroke ?? 'none'} strokeWidth={sw} />
      )}
    </svg>
  );
}

function paragraphStyle(p: PptxParagraph): CSSProperties {
  const size = (p.size ?? 18) * PT_TO_PX;
  const s: CSSProperties = {
    fontSize: size,
    textAlign: p.align ?? 'left',
    paddingLeft: (p.level ?? 0) * LEVEL_INDENT + (p.bullet ? size * 1.1 : 0),
  };
  if (p.bold) s.fontWeight = 700;
  if (p.italic) s.fontStyle = 'italic';
  if (p.color) s.color = p.color;
  return s;
}

function Paragraph({ p, label }: { p: PptxParagraph; label: string | null }) {
  const size = (p.size ?? 18) * PT_TO_PX;
  let content: ReactNode = p.text;
  if (p.runs?.length) {
    content = p.runs.map((r, i) => {
      const s: CSSProperties = {};
      if (r.size && r.size !== p.size) s.fontSize = r.size * PT_TO_PX;
      if (r.bold) s.fontWeight = 700;
      if (r.italic) s.fontStyle = 'italic';
      if (r.underline) s.textDecoration = 'underline';
      if (r.color) s.color = r.color;
      return (
        <span key={i} style={s}>
          {r.text}
        </span>
      );
    });
  }
  return (
    <p className="pptx-p" style={paragraphStyle(p)}>
      {label && (
        <span className="pptx-bullet" style={{ marginLeft: -size * 1.1, width: size * 1.1 }} aria-hidden="true">
          {label}
        </span>
      )}
      {content || '​'}
    </p>
  );
}

function Element({ e }: { e: PptxElement }) {
  if (e.kind === 'image') {
    return <img className="pptx-el pptx-image" style={boxStyle(e)} src={e.url} alt={e.alt ?? ''} loading="lazy" decoding="async" draggable={false} />;
  }
  if (e.kind === 'shape') {
    return (
      <div className="pptx-el pptx-shape" style={boxStyle(e)}>
        <ShapeSvg geom={e.geom} w={e.w} h={e.h} fill={e.fill} stroke={e.stroke} strokeWidth={e.strokeWidth} />
      </div>
    );
  }
  const labels = bulletLabels(e.paragraphs);
  const va = e.verticalAlign ?? 'top';
  return (
    <div className={`pptx-el pptx-text pptx-va-${va}`} style={boxStyle(e)}>
      {(e.fill || e.stroke) && <ShapeSvg geom={e.geom ?? 'rect'} w={e.w} h={e.h} fill={e.fill} stroke={e.stroke} />}
      <div className="pptx-text-body" style={{ padding: `${INSET_Y}px ${INSET_X}px` }}>
        {e.paragraphs.map((p, i) => (
          <Paragraph key={i} p={p} label={labels[i]} />
        ))}
      </div>
    </div>
  );
}

export function PptxSlideView({ deck, slide, width, className, label }: PptxSlideViewProps) {
  const scale = width / deck.width;
  const height = Math.round(deck.height * scale * 100) / 100;
  return (
    <div
      className={`pptx-slide${className ? ' ' + className : ''}`}
      style={{ width, height }}
      role="img"
      aria-label={label ?? slide.title ?? `Slide ${slide.index + 1}`}
    >
      <div
        className="pptx-stage"
        style={{
          width: deck.width,
          height: deck.height,
          transform: `scale(${scale})`,
          background: slide.background ?? DEFAULT_BG,
          color: DEFAULT_TEXT,
          fontFamily: SLIDE_FONT,
          lineHeight: LINE_HEIGHT,
        }}
      >
        {slide.elements.map((e, i) => (
          <Element key={i} e={e} />
        ))}
      </div>
    </div>
  );
}

export default PptxSlideView;
