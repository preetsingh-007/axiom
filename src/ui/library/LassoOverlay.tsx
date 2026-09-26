import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * Freeform lasso over a source. Active when the lasso tool is on; additionally a stylus
 * (pen) or Alt+drag always lassos, since pristine sources are never inked directly.
 * Reports the polygon in client coordinates.
 */
export function LassoOverlay({
  active,
  penLasso,
  target,
  onComplete,
}: {
  active: boolean;
  penLasso: boolean;
  target: RefObject<HTMLElement | null>;
  onComplete(poly: [number, number][], bbox: DOMRect): void;
}) {
  const [points, setPoints] = useState<[number, number][] | null>(null);
  const pts = useRef<[number, number][]>([]);
  const cbRef = useRef(onComplete);
  cbRef.current = onComplete;

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    el.classList.toggle('lasso-active', active);
    let pointerId: number | null = null;
    let raf = 0;

    const down = (e: PointerEvent) => {
      const want = (active && (e.button === 0 || e.pointerType !== 'mouse')) || (penLasso && e.pointerType === 'pen') || (e.altKey && e.pointerType === 'mouse');
      if (!want || pointerId !== null) return;
      if ((e.target as HTMLElement).closest('button, a, input, .extract-card, .sel-menu')) return;
      e.preventDefault();
      pointerId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      window.getSelection()?.removeAllRanges();
      pts.current = [[e.clientX, e.clientY]];
      setPoints([...pts.current]);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents?.() ?? [e];
      for (const ev of evs) pts.current.push([ev.clientX, ev.clientY]);
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          setPoints([...pts.current]);
        });
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      const poly = pts.current;
      pts.current = [];
      setPoints(null);
      if (poly.length < 3) return;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const [x, y] of poly) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      if (x1 - x0 < 12 || y1 - y0 < 8) return;
      cbRef.current(poly, new DOMRect(x0, y0, x1 - x0, y1 - y0));
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      pts.current = [];
      setPoints(null);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.classList.remove('lasso-active');
      cancelAnimationFrame(raf);
    };
  }, [active, penLasso, target]);

  if (!points) return null;
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + ' Z';
  return createPortal(
    <svg className="lasso-svg" aria-hidden>
      <path d={d} />
    </svg>,
    document.body,
  );
}
