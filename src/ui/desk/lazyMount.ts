/**
 * Progressive mounting for very long pages: blocks near the viewport mount immediately,
 * the rest mount in small batches during idle time, so a 2,000-block page paints in a
 * frame or two but still ends up fully in the DOM (browser find, accessibility).
 */

type Task = () => void;

const queue: Task[] = [];
let scheduled = false;
const BATCH_MS = 8;
/** mounts per idle slice: React renders them in one commit, so keep each commit small */
const BATCH_SIZE = 12;

const ric: (cb: (d: { timeRemaining(): number }) => void) => void =
  typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? (cb) => (window as unknown as { requestIdleCallback: (cb: (d: { timeRemaining(): number }) => void, o?: { timeout: number }) => void }).requestIdleCallback(cb, { timeout: 200 })
    : (cb) => setTimeout(() => cb({ timeRemaining: () => BATCH_MS }), 16);

function pump() {
  scheduled = false;
  ric((deadline) => {
    let n = 0;
    while (queue.length && n < BATCH_SIZE && (n < 2 || deadline.timeRemaining() > 1)) {
      queue.shift()!();
      n++;
    }
    if (queue.length) schedule();
  });
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  pump();
}

/** Queues a mount; returns a cancel function. */
export function scheduleMount(task: Task): () => void {
  queue.push(task);
  schedule();
  return () => {
    const i = queue.indexOf(task);
    if (i >= 0) queue.splice(i, 1);
  };
}

let io: IntersectionObserver | null = null;
const ioCallbacks = new WeakMap<Element, () => void>();

/** Calls `fn` once when the element comes within ~1.5 viewports of the screen. */
export function whenNearViewport(el: Element, fn: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    fn();
    return () => {};
  }
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const cb = ioCallbacks.get(e.target);
          io!.unobserve(e.target);
          ioCallbacks.delete(e.target);
          cb?.();
        }
      },
      { rootMargin: '1500px 0px' },
    );
  }
  ioCallbacks.set(el, fn);
  io.observe(el);
  return () => {
    io?.unobserve(el);
    ioCallbacks.delete(el);
  };
}

/** Remembered block heights so placeholders don't make the scrollbar jump. */
export const blockHeights = new Map<string, number>();

/** Pages shorter than this render everything eagerly. */
export const EAGER_BLOCKS = 40;
