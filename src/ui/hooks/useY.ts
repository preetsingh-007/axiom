import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyYType = Y.AbstractType<any>;

/** Re-renders whenever the given Yjs type (or anything below it) changes. */
export function useYDeep(type: AnyYType | null | undefined): number {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!type) return;
    const fn = () => bump();
    type.observeDeep(fn);
    return () => type.unobserveDeep(fn);
  }, [type]);
  return version;
}

/** Re-renders on shallow changes only (keys added/removed/replaced). */
export function useYShallow(type: AnyYType | null | undefined): number {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!type) return;
    const fn = () => bump();
    type.observe(fn);
    return () => type.unobserve(fn);
  }, [type]);
  return version;
}

/**
 * Subscribes to a derived value of a Yjs type; re-renders only if the selected value
 * changes (by `isEqual`). Keeps big lists from re-rendering on unrelated edits.
 */
export function useYSelect<T, Ty extends AnyYType>(
  type: Ty | null | undefined,
  select: (t: Ty) => T,
  opts: { deep?: boolean; isEqual?: (a: T, b: T) => boolean } = {},
): T | undefined {
  const selectRef = useRef(select);
  selectRef.current = select;
  const isEqual = opts.isEqual ?? shallowEqual;
  const cache = useRef<{ type: Ty | null | undefined; value: T | undefined } | null>(null);

  const subscribe = (cb: () => void) => {
    if (!type) return () => {};
    const fn = () => cb();
    if (opts.deep) type.observeDeep(fn);
    else type.observe(fn);
    return () => (opts.deep ? type.unobserveDeep(fn) : type.unobserve(fn));
  };
  const get = () => {
    const next = type ? selectRef.current(type) : undefined;
    if (cache.current && cache.current.type === type && cache.current.value !== undefined && next !== undefined && isEqual(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { type, value: next };
    return next;
  };
  return useSyncExternalStore(subscribe, get, get);
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    return true;
  }
  return false;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
