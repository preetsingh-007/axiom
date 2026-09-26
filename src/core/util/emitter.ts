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
