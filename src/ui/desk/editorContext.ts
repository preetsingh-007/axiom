import { createContext, useContext, useEffect } from 'react';
import type * as Y from 'yjs';

export type FocusAt = 'start' | 'end' | number;

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
