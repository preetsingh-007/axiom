import { createContext, useContext, useEffect } from 'react';
import type * as Y from 'yjs';

export type FocusAt = 'start' | 'end' | number;

/**
 * Keystrokes typed while focus hops between blocks (Enter → new block) arrive before the next
 * editor exists. They are buffered here and replayed by the editor that mounts next.
 */
const typeahead = {
  active: false,
  text: '',
  /** when capturing stopped without an editor claiming the text */
  stashedAt: 0,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
};

function onTypeaheadKey(e: KeyboardEvent) {
  if (!typeahead.active || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (e.key.length === 1) {
    typeahead.text += e.key;
    e.preventDefault();
    e.stopPropagation();
  }
}

function stopCapture() {
  if (!typeahead.active) return;
  typeahead.active = false;
  clearTimeout(typeahead.timer);
  window.removeEventListener('keydown', onTypeaheadKey, true);
}

export function startTypeahead() {
  if (typeof window === 'undefined') return;
  if (!typeahead.active) {
    typeahead.text = '';
    window.addEventListener('keydown', onTypeaheadKey, true);
  }
  typeahead.active = true;
  clearTimeout(typeahead.timer);
  // safety net: never capture keys indefinitely if no editor mounts; keep what was typed
  typeahead.timer = setTimeout(() => {
    stopCapture();
    typeahead.stashedAt = Date.now();
  }, 3000);
}

/** Stops buffering and returns what was typed during the hand-off. */
export function takeTypeahead(): string {
  const stashed = !typeahead.active && typeahead.text && Date.now() - typeahead.stashedAt < 5000;
  if (!typeahead.active && !stashed) return '';
  stopCapture();
  const t = typeahead.text;
  typeahead.text = '';
  return t;
}

/**
 * Per-page editor API shared by all blocks of one page view: focus hand-off between blocks
 * (arrow keys, Enter splitting, Backspace merging) without re-rendering the whole list.
 */
export class PageEditorApi {
  private pending = new Map<string, FocusAt>();
  private listeners = new Map<string, () => void>();
  /** block currently in edit mode (one per page view) */
  editing: string | null = null;

  constructor(
    readonly pageId: string,
    readonly doc: Y.Doc,
    readonly readOnly = false,
  ) {}

  focus(blockId: string, at: FocusAt = 'end') {
    startTypeahead();
    this.pending.set(blockId, at);
    this.listeners.get(blockId)?.();
  }

  takeFocus(blockId: string): FocusAt | undefined {
    const at = this.pending.get(blockId);
    this.pending.delete(blockId);
    return at;
  }

  hasPending(blockId: string) {
    return this.pending.has(blockId);
  }

  listen(blockId: string, fn: () => void) {
    this.listeners.set(blockId, fn);
    if (this.pending.has(blockId)) fn();
    return () => {
      if (this.listeners.get(blockId) === fn) this.listeners.delete(blockId);
    };
  }
}

export const PageEditorContext = createContext<PageEditorApi | null>(null);

export function usePageEditor(): PageEditorApi | null {
  return useContext(PageEditorContext);
}

/** Calls `fn` whenever someone requests focus for this block. */
export function useFocusRequest(api: PageEditorApi | null, blockId: string, fn: (at: FocusAt) => void) {
  useEffect(() => {
    if (!api) return;
    return api.listen(blockId, () => {
      const at = api.takeFocus(blockId);
      if (at !== undefined) fn(at);
    });
    // fn intentionally excluded: callers pass inline closures reading refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, blockId]);
}

/** Environment the editor needs from the app (completion data, navigation). */
export interface EditorEnv {
  pageTitles(): string[];
  tagNames(): string[];
  openPage(title: string, opts?: { sideQuest?: boolean }): void;
  openBlockRef(blockId: string): void;
  pickImage(): Promise<File | null>;
}

export const EditorEnvContext = createContext<EditorEnv | null>(null);

export function useEditorEnv(): EditorEnv {
  const env = useContext(EditorEnvContext);
  if (!env) throw new Error('EditorEnvContext missing');
  return env;
}
