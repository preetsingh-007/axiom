import { useEffect, type RefObject } from 'react';
import type * as Y from 'yjs';
import { blockIds, blockStrokes, blockType, deleteBlock, getBlock, insertBlock } from '../../core/blocks';
import { INK_LOGICAL_WIDTH, type Stroke } from '../../core/schema';
import { LOCAL_ORIGIN } from '../../core/storage/docstore';

/**
 * The Elastic Canvas ("accordion margin").
 *  - Two-finger vertical SPREAD between blocks injects whiteboard space at that gap (or grows
 *    an adjacent whiteboard); the space follows the fingers live and is committed on release.
 *  - Two-finger vertical PINCH over/next to a whiteboard shrinks it; an empty whiteboard pinched
 *    below a threshold snaps shut (is removed). Never cuts through existing ink.
 *  - Trackpad pinch (ctrl+wheel) and a keyboard shortcut provide the same on laptops.
 */

export const MIN_SPACE = 140; // logical units: smaller empty whiteboards snap shut
const ACTIVATE_PX = 12;

interface Gap {
  /** insertion index in the visible block list */
  index: number;
  /** DOM element the ghost is inserted before (null = end) */
  before: HTMLElement | null;
  /** ink block adjacent to the gap (prefers the one above) */
  inkId: string | null;
  inkEl: HTMLElement | null;
}

function blockEls(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(':scope > .blist-items > .blk')];
}

/** Finds the gap between blocks closest to clientY. */
export function findGap(container: HTMLElement, clientY: number): Gap {
  const els = blockEls(container);
  let index = els.length;
  let before: HTMLElement | null = null;
  let inside: HTMLElement | null = null;
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (clientY >= r.top && clientY <= r.bottom) inside = els[i];
    if (clientY < r.top + r.height / 2) {
      index = i;
      before = els[i];
      break;
    }
  }
  const pick = (el: HTMLElement | null | undefined) => (el && el.dataset.blockType === 'ink' ? el : null);
  const inkEl = pick(inside) ?? pick(els[index - 1]) ?? pick(els[index]);
  return { index, before, inkId: inkEl?.dataset.blockId ?? null, inkEl };
}

function strokesBottom(strokes: Stroke[]): number {
  let max = 0;
  for (const s of strokes) for (let i = 1; i < s.pts.length; i += 3) if (s.pts[i] > max) max = s.pts[i];
  return max;
}

export interface AccordionHandle {
  begin(clientY: number): void;
  update(deltaPx: number): void;
  end(): void;
  cancel(): void;
}

/** Imperative gesture state machine shared by touch, trackpad and tests. */
export function createAccordion(container: HTMLElement, doc: Y.Doc): AccordionHandle {
  let gap: Gap | null = null;
  let ghost: HTMLDivElement | null = null;
  let delta = 0;
  let baseHeightPx = 0;
  const scale = () => (container.querySelector('.blist-items')?.clientWidth || container.clientWidth || INK_LOGICAL_WIDTH) / INK_LOGICAL_WIDTH;

  const cleanup = () => {
    ghost?.remove();
    ghost = null;
    if (gap?.inkEl) {
      gap.inkEl.style.removeProperty('--accordion-h');
      gap.inkEl.classList.remove('accordion-shrinking', 'accordion-growing');
    }
    container.classList.remove('accordion-active');
    gap = null;
    delta = 0;
  };

  return {
    begin(clientY) {
      cleanup();
      gap = findGap(container, clientY);
      container.classList.add('accordion-active');
      if (gap.inkId) {
        const b = getBlock(doc, gap.inkId);
        baseHeightPx = ((b?.get('height') as number) ?? 300) * scale();
      }
    },
    update(d) {
      if (!gap) return;
      delta = d;
      if (d >= 0) {
        if (gap.inkEl) {
          // grow the adjacent whiteboard live
          gap.inkEl.classList.add('accordion-growing');
          gap.inkEl.style.setProperty('--accordion-h', `${baseHeightPx + d}px`);
          return;
        }
        if (!ghost) {
          ghost = document.createElement('div');
          ghost.className = 'accordion-ghost';
          ghost.innerHTML = '<span>Release to add whiteboard space</span>';
          const items = container.querySelector('.blist-items')!;
          items.insertBefore(ghost, gap.before);
        }
        ghost.style.height = `${d}px`;
        ghost.classList.toggle('ready', d > 40);
      } else if (gap.inkEl) {
        gap.inkEl.classList.add('accordion-shrinking');
        gap.inkEl.style.setProperty('--accordion-h', `${Math.max(24, baseHeightPx + d)}px`);
      }
    },
    end() {
      if (!gap) return cleanup();
      const s = scale();
      const logicalDelta = delta / s;
      const g = gap;
      if (logicalDelta > 0) {
        if (g.inkId) {
          const b = getBlock(doc, g.inkId);
          if (b) doc.transact(() => b.set('height', Math.round(((b.get('height') as number) ?? 300) + logicalDelta)), LOCAL_ORIGIN);
        } else if (delta > 40) {
          insertBlock(doc, { type: 'ink', height: Math.max(MIN_SPACE + 60, Math.round(logicalDelta)) }, g.index);
        }
      } else if (logicalDelta < 0 && g.inkId) {
        const b = getBlock(doc, g.inkId);
        if (b && blockType(b) === 'ink') {
          const strokes = blockStrokes(b)?.toArray() ?? [];
          const cur = (b.get('height') as number) ?? 300;
          const target = cur + logicalDelta;
          if (!strokes.length && target < MIN_SPACE) {
            // snap shut
            g.inkEl?.classList.add('accordion-closing');
            deleteBlock(doc, g.inkId);
          } else {
            const floor = strokes.length ? strokesBottom(strokes) + 40 : MIN_SPACE;
            doc.transact(() => b.set('height', Math.round(Math.max(floor, target))), LOCAL_ORIGIN);
          }
        }
      }
      cleanup();
    },
    cancel: cleanup,
  };
}

/**
 * Wires two-finger touch gestures and trackpad pinch on a block list container.
 */
export function useAccordion(ref: RefObject<HTMLElement | null>, doc: Y.Doc | null, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !doc || !enabled) return;
    const acc = createAccordion(el, doc);
    let touch: { startDist: number; startDx: number; active: boolean; decided: boolean } | null = null;

    const vDist = (t: TouchList) => Math.abs(t[0].clientY - t[1].clientY);
    const hDist = (t: TouchList) => Math.abs(t[0].clientX - t[1].clientX);

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        touch = { startDist: vDist(e.touches), startDx: hDist(e.touches), active: false, decided: false };
        acc.begin(midY);
      } else if (e.touches.length > 2 && touch) {
        acc.cancel();
        touch = null;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!touch || e.touches.length !== 2) return;
      e.preventDefault(); // two fingers on the page belong to the accordion, not to scrolling/zoom
      const dv = vDist(e.touches) - touch.startDist;
      const dh = hDist(e.touches) - touch.startDx;
      if (!touch.decided) {
        if (Math.abs(dv) < ACTIVATE_PX && Math.abs(dh) < ACTIVATE_PX) return;
        touch.decided = true;
        touch.active = Math.abs(dv) >= Math.abs(dh);
      }
      if (touch.active) acc.update(dv);
    };
    const onEnd = (e: TouchEvent) => {
      if (!touch) return;
      if (e.touches.length < 2) {
        if (touch.active) acc.end();
        else acc.cancel();
        touch = null;
      }
    };

    // trackpad pinch arrives as ctrl+wheel
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    let wheelDelta = 0;
    let wheelActive = false;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (!wheelActive) {
        acc.begin(e.clientY);
        wheelActive = true;
        wheelDelta = 0;
      }
      wheelDelta += -e.deltaY * 2.2;
      acc.update(wheelDelta);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        acc.end();
        wheelActive = false;
      }, 260);
    };

    el.addEventListener('touchstart', onStart, { passive: true, capture: true });
    el.addEventListener('touchmove', onMove, { passive: false, capture: true });
    el.addEventListener('touchend', onEnd, { capture: true });
    el.addEventListener('touchcancel', onEnd, { capture: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart, { capture: true });
      el.removeEventListener('touchmove', onMove, { capture: true });
      el.removeEventListener('touchend', onEnd, { capture: true });
      el.removeEventListener('touchcancel', onEnd, { capture: true });
      el.removeEventListener('wheel', onWheel);
      clearTimeout(wheelTimer);
      acc.cancel();
    };
  }, [ref, doc, enabled]);
}

/** Keyboard/mouse path: insert whiteboard space at a visible index. */
export function insertSpaceAt(doc: Y.Doc, index: number, height = 360) {
  const ids = blockIds(doc);
  return insertBlock(doc, { type: 'ink', height }, Math.min(index, ids.length));
}
