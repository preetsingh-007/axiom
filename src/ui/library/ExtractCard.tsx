import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SendToBack, X, Type, Sigma, Image as ImageIcon, GripHorizontal, Sparkles, Copy } from 'lucide-react';
import { extractionToBlocks, refineMath, type ExtractKind, type Extraction } from './extraction';
import { renderMarkdown, renderMath } from '../markdown/render';
import { EXTRACT_MIME } from '../desk/dragout';
import { sendToDesk } from '../app/actions';
import type { NewBlock } from '../../core/blocks';
import { copyText } from '../desk/dragout';
import { useUI } from '../app/store';

/**
 * Semantic paste preview for a lasso: shows what will land on the Desk (Markdown, LaTeX or an
 * image), lets the user switch the interpretation, and can be dragged onto any Desk position.
 */
export function ExtractCard({ ex, anchor, onClose }: { ex: Extraction; anchor: DOMRect; onClose(): void }) {
  const [kind, setKind] = useState<ExtractKind>(ex.kind);
  const [latex, setLatex] = useState(ex.latex);
  const [refining, setRefining] = useState(false);
  const [aiUsed, setAiUsed] = useState(false);
  const [blocks, setBlocks] = useState<NewBlock[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.right + 12, top: anchor.top });
  const toast = useUI((s) => s.toast);
  const current = useMemo(() => ({ ...ex, latex }), [ex, latex]);

  // exact LaTeX via a vision model when one is configured
  useEffect(() => {
    if (ex.kind !== 'math') return;
    let alive = true;
    setRefining(true);
    refineMath(ex).then((tex) => {
      if (!alive) return;
      setRefining(false);
      if (tex) {
        setLatex(tex);
        setAiUsed(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [ex]);

  // prepare blocks eagerly so drag start can be synchronous
  useEffect(() => {
    let alive = true;
    setBlocks(null);
    extractionToBlocks(current, kind).then((b) => alive && setBlocks(b));
    return () => {
      alive = false;
    };
  }, [current, kind]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchor.right + 12;
    if (left + w > window.innerWidth - 8) left = Math.max(8, anchor.left - w - 12);
    if (left < 8) left = Math.max(8, Math.min(window.innerWidth - w - 8, anchor.left));
    let top = anchor.top;
    if (top + h > window.innerHeight - 8) top = Math.max(60, window.innerHeight - h - 8);
    setPos({ left, top });
  }, [anchor, kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const imgUrl = useMemo(() => (ex.image ? URL.createObjectURL(ex.image.blob) : undefined), [ex.image]);
  useEffect(
    () => () => {
      if (imgUrl) URL.revokeObjectURL(imgUrl);
    },
    [imgUrl],
  );

  const send = async () => {
    const b = blocks ?? (await extractionToBlocks(current, kind));
    await sendToDesk(b);
    onClose();
  };

  const preview =
    kind === 'figure' ? (
      imgUrl ? <img src={imgUrl} alt="Extracted region" /> : <div className="extract-empty">No image</div>
    ) : kind === 'math' ? (
      <div className="extract-math" dangerouslySetInnerHTML={{ __html: latex ? renderMath(latex, true) : '<span class="blk-faint">No math recognised</span>' }} />
    ) : (
      <div className="extract-md md" dangerouslySetInnerHTML={{ __html: ex.markdown.trim() ? renderMarkdown(ex.markdown) : '<p class="blk-faint">No text found in this region — try Image.</p>' }} />
    );

  return createPortal(
    <div
      ref={ref}
      className="extract-card"
      style={pos}
      role="dialog"
      aria-label="Extracted selection"
      draggable={!!blocks}
      onDragStart={(e) => {
        if (!blocks) return e.preventDefault();
        e.dataTransfer.setData(EXTRACT_MIME, JSON.stringify({ blocks }));
        e.dataTransfer.setData('text/plain', kind === 'math' ? `$$\n${latex}\n$$` : ex.markdown || ex.quote);
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <div className="extract-head">
        <GripHorizontal size={15} className="extract-grip" aria-hidden />
        <div className="extract-kinds" role="radiogroup" aria-label="Paste as">
          <button role="radio" aria-checked={kind === 'text'} className={kind === 'text' ? 'on' : ''} onClick={() => setKind('text')}>
            <Type size={14} /> Text
          </button>
          <button role="radio" aria-checked={kind === 'math'} className={kind === 'math' ? 'on' : ''} onClick={() => setKind('math')}>
            <Sigma size={14} /> LaTeX
          </button>
          <button role="radio" aria-checked={kind === 'figure'} className={kind === 'figure' ? 'on' : ''} onClick={() => setKind('figure')} disabled={!ex.image}>
            <ImageIcon size={14} /> Image
          </button>
        </div>
        <button className="ui-icon-btn" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </div>
      <div className="extract-preview">{preview}</div>
      {kind === 'math' && (
        <div className="extract-meta">
          {refining ? (
            <span className="extract-refining">
              <span className="ui-spinner" /> Reading equation…
            </span>
          ) : aiUsed ? (
            <span>
              <Sparkles size={12} /> Transcribed by AI
            </span>
          ) : (
            <span>Converted from text layer</span>
          )}
        </div>
      )}
      <div className="extract-actions">
        <span className="extract-hint">Drag onto the Desk, or</span>
        <button
          className="ui-btn small ghost"
          onClick={() => copyText(kind === 'math' ? latex : ex.markdown || ex.quote).then(() => toast({ message: 'Copied' }))}
          aria-label="Copy"
          title="Copy"
        >
          <Copy size={14} />
        </button>
        <button className="ui-btn small primary" onClick={send} disabled={!blocks}>
          <SendToBack size={14} /> Send to Desk
        </button>
      </div>
    </div>,
    document.body,
  );
}
