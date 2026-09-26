import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { useServices } from '../app/services';
import { blockIds, blocksOf, orderOf } from '../../core/blocks';
import { shallowEqual, useYSelect } from './useY';
import type { PageMeta } from '../../core/schema';

/** Opens (and pins) a page doc for the lifetime of the component. */
export function usePageDoc(pageId: string | null | undefined): Y.Doc | null {
  const { vault } = useServices();
  const [doc, setDoc] = useState<Y.Doc | null>(() => (pageId ? (vault.store.getLoaded(pageId) ?? null) : null));
  useEffect(() => {
    if (!pageId) {
      setDoc(null);
      return;
    }
    let release: (() => void) | undefined;
    let cancelled = false;
    const loaded = vault.store.getLoaded(pageId);
    if (loaded) setDoc(loaded);
    vault.openPage(pageId).then((h) => {
      if (cancelled) return h.release();
      release = h.release;
      setDoc(h.doc);
    });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [vault, pageId]);
  return doc && doc.guid === pageId ? doc : null;
}

/** Ordered, de-duplicated block ids; re-renders only when the id list changes. */
export function useBlockIds(doc: Y.Doc | null): string[] {
  const cache = useRef<{ doc: Y.Doc | null; ids: string[] }>({ doc: null, ids: [] });
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!doc) return () => {};
      // order changes cover inserts/moves; blocks map (shallow) covers orphan deletions
      const order = orderOf(doc);
      const blocks = blocksOf(doc);
      order.observe(cb);
      blocks.observe(cb);
      return () => {
        order.unobserve(cb);
        blocks.unobserve(cb);
      };
    },
    [doc],
  );
  const get = () => {
    const ids = doc ? blockIds(doc) : EMPTY;
    const c = cache.current;
    if (c.doc === doc && shallowEqual(c.ids, ids)) return c.ids;
    cache.current = { doc, ids };
    return ids;
  };
  return useSyncExternalStore(subscribe, get, get);
}

const EMPTY: string[] = [];

/** Reactive page metadata from the index doc. */
export function usePageMeta(pageId: string | null | undefined): PageMeta | undefined {
  const { vault } = useServices();
  const m = pageId ? vault.pages.get(pageId) : undefined;
  const meta = useYSelect(m, (x) => x.toJSON() as PageMeta);
  // the page map itself might be created later (sync): subscribe to the registry
  useYSelect(vault.pages, (p) => (pageId ? p.has(pageId) : false));
  return meta ?? (pageId ? vault.getPage(pageId) : undefined);
}

export function useYText(text: Y.Text | undefined): string {
  return useYSelect(text, (t) => t.toString(), { isEqual: (a, b) => a === b }) ?? '';
}

export function useBlobUrl(blobId: string | undefined): string | undefined {
  const { vault } = useServices();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blobId) return;
    let alive = true;
    vault.blobUrl(blobId).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [vault, blobId]);
  return url;
}
