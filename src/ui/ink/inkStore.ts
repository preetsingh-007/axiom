/**
 * Global ink tool state (shared by every InkCanvas and the toolbar).
 *
 * `tool: 'none'` is typing/pointer mode: ink blocks don't capture pointers, so the page scrolls
 * and text selection works. The first time a pen (stylus) pointer is seen anywhere, `penDetected`
 * flips on and, if in pointer mode, the pen tool is selected automatically.
 */
import { create } from 'zustand';
import { CURRENT_INK } from '../../core/ink/render';

export type InkTool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'none';

/** Pen colours; `currentInk` follows --ink-default (legible in light and dark themes). */
export const INK_COLORS: string[] = [CURRENT_INK, '#e5484d', '#3e7bfa', '#30a46c', '#f76b15', '#8e4ec6'];
/** Highlighter colours (rendered at 35% opacity). */
export const HIGHLIGHTER_COLORS: string[] = ['#ffd60a', '#40c057', '#4dabf7', '#f06595', '#ff922b', '#b197fc'];
/** Pen widths in logical units (block width = 1000). */
export const PEN_SIZES: number[] = [2.5, 4, 7];
/** Highlighter widths in logical units. */
export const HIGHLIGHTER_SIZES: number[] = [14, 22, 34];
/** Eraser radius in logical units. */
export const ERASER_RADIUS = 8;

export interface InkState {
  tool: InkTool;
  /** pen colour (hex or 'currentInk') */
  color: string;
  highlighterColor: string;
  /** index into PEN_SIZES / HIGHLIGHTER_SIZES */
  sizeIndex: number;
  /** pen width in logical units (derived from sizeIndex) */
  size: number;
  palette: string[];
  highlighterPalette: string[];
  /** a stylus has been seen: fingers never draw (palm rejection) */
  penDetected: boolean;
  setTool(tool: InkTool): void;
  setColor(color: string): void;
  setSizeIndex(i: number): void;
  setPenDetected(v: boolean): void;
}

export const useInkStore = create<InkState>((set, get) => ({
  tool: 'none',
  color: CURRENT_INK,
  highlighterColor: HIGHLIGHTER_COLORS[0],
  sizeIndex: 0,
  size: PEN_SIZES[0],
  palette: INK_COLORS,
  highlighterPalette: HIGHLIGHTER_COLORS,
  penDetected: false,
  setTool: (tool) => set({ tool }),
  setColor: (color) => (get().tool === 'highlighter' ? set({ highlighterColor: color }) : set({ color })),
  setSizeIndex: (i) => {
    const idx = Math.max(0, Math.min(PEN_SIZES.length - 1, i));
    set({ sizeIndex: idx, size: PEN_SIZES[idx] });
  },
  setPenDetected: (v) => {
    if (get().penDetected === v) return;
    set(v && get().tool === 'none' ? { penDetected: true, tool: 'pen' } : { penDetected: v });
  },
}));

/** Stroke width in logical units for the given tool and size index. */
export function strokeWidthFor(tool: 'pen' | 'highlighter', sizeIndex: number): number {
  return tool === 'highlighter' ? HIGHLIGHTER_SIZES[sizeIndex] ?? HIGHLIGHTER_SIZES[0] : PEN_SIZES[sizeIndex] ?? PEN_SIZES[0];
}

/** True when the tool captures pointer input on ink blocks. */
export function isDrawingTool(tool: InkTool): boolean {
  return tool !== 'none';
}
