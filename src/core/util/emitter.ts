export type Listener<T> = (value: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(value: T) {
    for (const fn of [...this.listeners]) fn(value);
  }
  get size() {
    return this.listeners.size;
  }
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn(...args);
    }, ms);
  };
  d.flush = (...args: A) => {
    if (t) clearTimeout(t);
    t = undefined;
    fn(...args);
  };
  d.cancel = () => {
    if (t) clearTimeout(t);
    t = undefined;
  };
  return d;
}

/**
 * Wraps an async job so runs never overlap: a call while one is running queues exactly one
 * follow-up run (later calls coalesce into it). Resolves when the caller's run has finished.
 */
export function serialized(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const run = (): Promise<void> => {
    const p: Promise<void> = fn().finally(() => {
      if (running === p) running = null;
    });
    running = p;
    return p;
  };
  return () => {
    if (queued) return queued;
    if (!running) return run();
    queued = running
      .catch(() => {})
      .then(() => {
        queued = null;
        return run();
      });
    return queued;
  };
}
