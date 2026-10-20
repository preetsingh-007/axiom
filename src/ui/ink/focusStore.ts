/**
 * Which whiteboard or photo is open in the full-screen focus view (see FocusView.tsx).
 *
 *   openFocus({ block, kind: 'whiteboard' })
 *   openFocus({ block, kind: 'photo', image: { blobId, w, h } })
 *
 * The focus view edits the very same Y.Map as the block in the note, so strokes appear in the
 * note (and on other devices) as they are drawn.
 */
import { create } from 'zustand';
import type * as Y from 'yjs';

export interface FocusPhoto {
  /** stored image (image blocks) */
  blobId?: string;
  /** already-resolved URL (slides rendered from their source) */
  url?: string;
  w: number;
  h: number;
}

export interface FocusTarget {
  block: Y.Map<unknown>;
  kind: 'whiteboard' | 'photo';
  image?: FocusPhoto;
  title?: string;
}

interface FocusState {
  target: FocusTarget | null;
  open(t: FocusTarget): void;
  close(): void;
}

export const useFocusInk = create<FocusState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export function openFocus(t: FocusTarget) {
  useFocusInk.getState().open(t);
}
