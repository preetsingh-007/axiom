import { create } from 'zustand';
import type { SourceLocator } from '../../core/schema';

export type Route =
  | { name: 'stream' }
  | { name: 'page'; pageId: string; blockId?: string }
  | { name: 'library' }
  | { name: 'lens'; lensId?: string; query?: string }
  | { name: 'graph'; focus?: string }
  | { name: 'review' }
  | { name: 'settings'; section?: string };

export interface ReaderState {
  sourceId: string;
  /** location to jump to when opening (wormhole) */
  jump?: { loc: SourceLocator; flash?: boolean; nonce: number };
}

export type Theme = 'light' | 'dark' | 'system';

interface UIState {
  route: Route;
  reader: ReaderState | null;
  /** on narrow screens only one pane is visible */
  mobilePane: 'desk' | 'reader';
  splitRatio: number;
  sideQuest: { open: boolean; pageId?: string };
  sidebarOpen: boolean;
  paletteOpen: boolean;
  theme: Theme;
  toasts: Toast[];

  navigate(route: Route, opts?: { replace?: boolean }): void;
  openReader(sourceId: string, jump?: { loc: SourceLocator; flash?: boolean }): void;
  closeReader(): void;
  setMobilePane(p: 'desk' | 'reader'): void;
  setSplitRatio(r: number): void;
  openSideQuest(pageId?: string): void;
  closeSideQuest(): void;
  toggleSidebar(open?: boolean): void;
  setPalette(open: boolean): void;
  setTheme(t: Theme): void;
  toast(t: Omit<Toast, 'id'>): string;
  dismissToast(id: string): void;
}

export interface Toast {
  id: string;
  message: string;
  kind?: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
  secondary?: { label: string; run: () => void };
  timeout?: number;
}

export function routeToHash(r: Route): string {
  switch (r.name) {
    case 'stream':
      return '#/stream';
    case 'page':
      return `#/page/${encodeURIComponent(r.pageId)}${r.blockId ? '/' + encodeURIComponent(r.blockId) : ''}`;
    case 'library':
      return '#/library';
    case 'lens':
      return r.lensId ? `#/lens/${encodeURIComponent(r.lensId)}` : `#/lens${r.query ? '?q=' + encodeURIComponent(r.query) : ''}`;
    case 'graph':
      return '#/graph';
    case 'review':
      return '#/review';
    case 'settings':
      return `#/settings${r.section ? '/' + r.section : ''}`;
  }
}

export function hashToRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = h.split('?');
  const parts = pathPart.split('/').map(decodeURIComponent);
  switch (parts[0]) {
    case 'page':
      if (parts[1]) return { name: 'page', pageId: parts[1], blockId: parts[2] };
      break;
    case 'library':
      return { name: 'library' };
    case 'lens': {
      const q = new URLSearchParams(queryPart ?? '').get('q') ?? undefined;
      return parts[1] ? { name: 'lens', lensId: parts[1] } : { name: 'lens', query: q };
    }
    case 'graph':
      return { name: 'graph' };
    case 'review':
      return { name: 'review' };
    case 'settings':
      return { name: 'settings', section: parts[1] };
  }
  return { name: 'stream' };
}

function readTheme(): Theme {
  try {
    return (localStorage.getItem('axiom-theme') as Theme) || 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

let toastSeq = 0;

export const useUI = create<UIState>((set, get) => ({
  route: typeof location !== 'undefined' ? hashToRoute(location.hash) : { name: 'stream' },
  reader: null,
  mobilePane: 'desk',
  splitRatio: 0.5,
  sideQuest: { open: false },
  sidebarOpen: typeof window !== 'undefined' ? window.innerWidth >= 1100 : true,
  paletteOpen: false,
  theme: typeof window !== 'undefined' ? readTheme() : 'system',
  toasts: [],

  navigate(route, opts) {
    const hash = routeToHash(route);
    if (typeof location !== 'undefined' && location.hash !== hash) {
      if (opts?.replace) history.replaceState(null, '', hash);
      else history.pushState(null, '', hash);
    }
    set({ route, mobilePane: 'desk' });
    if (typeof window !== 'undefined' && window.innerWidth < 900) set({ sidebarOpen: false });
  },
  openReader(sourceId, jump) {
    set({
      reader: { sourceId, jump: jump ? { ...jump, nonce: Date.now() } : undefined },
      mobilePane: 'reader',
    });
  },
  closeReader() {
    set({ reader: null, mobilePane: 'desk' });
  },
  setMobilePane(p) {
    set({ mobilePane: p });
  },
  setSplitRatio(r) {
    set({ splitRatio: Math.min(0.8, Math.max(0.2, r)) });
  },
  openSideQuest(pageId) {
    set({ sideQuest: { open: true, pageId: pageId ?? get().sideQuest.pageId } });
  },
  closeSideQuest() {
    set({ sideQuest: { ...get().sideQuest, open: false } });
  },
  toggleSidebar(open) {
    set({ sidebarOpen: open ?? !get().sidebarOpen });
  },
  setPalette(open) {
    set({ paletteOpen: open });
  },
  setTheme(t) {
    try {
      localStorage.setItem('axiom-theme', t);
    } catch {
      /* private mode */
    }
    applyTheme(t);
    set({ theme: t });
  },
  toast(t) {
    const id = 't' + ++toastSeq;
    set({ toasts: [...get().toasts, { ...t, id }] });
    const timeout = t.timeout ?? (t.action ? 6000 : 3200);
    if (timeout > 0) setTimeout(() => get().dismissToast(id), timeout);
    return id;
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) });
  },
}));

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => useUI.setState({ route: hashToRoute(location.hash) }));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (useUI.getState().theme === 'system') applyTheme('system');
  });
}
