import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { useUI } from './store';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { StreamView } from '../desk/StreamView';
import { PageView } from '../desk/PageView';
import { Toasts } from './Toasts';
import { Palette } from './Palette';
import { SideQuest } from '../desk/SideQuest';
import { useGlobalShortcuts } from './shortcuts';
import { GlobalDrop } from './GlobalDrop';
import { EditorEnvProvider } from './EditorEnvProvider';
import { AIBridgeDialog } from '../review/AIBridgeDialog';
import { useInkShortcuts, InkToolbar } from '../ink/InkToolbar';

const LibraryView = lazy(() => import('../library/LibraryView').then((m) => ({ default: m.LibraryView })));
const ReaderPane = lazy(() => import('../library/ReaderPane').then((m) => ({ default: m.ReaderPane })));
const LensView = lazy(() => import('../desk/LensView').then((m) => ({ default: m.LensView })));
const GraphRoute = lazy(() => import('./GraphRoute').then((m) => ({ default: m.GraphRoute })));
const ReviewRoute = lazy(() => import('./ReviewRoute').then((m) => ({ default: m.ReviewRoute })));
const Settings = lazy(() => import('./Settings').then((m) => ({ default: m.Settings })));

function Loading() {
  return (
    <div className="route-loading">
      <div className="ui-spinner" />
    </div>
  );
}

function DeskContent() {
  const route = useUI((s) => s.route);
  let content: ReactNode;
  switch (route.name) {
    case 'stream':
      content = <StreamView />;
      break;
    case 'page':
      content = <PageView key={route.pageId} pageId={route.pageId} blockId={route.blockId} />;
      break;
    case 'library':
      content = <LibraryView />;
      break;
    case 'lens':
      content = <LensView lensId={route.lensId} initialQuery={route.query} />;
      break;
    case 'graph':
      return (
        <Suspense fallback={<Loading />}>
          <GraphRoute focus={route.focus} />
        </Suspense>
      );
    case 'review':
      content = <ReviewRoute />;
      break;
    case 'settings':
      content = <Settings section={route.section} />;
      break;
  }
  return (
    <div className="desk-scroll" data-route={route.name}>
      <div className={`desk-inner${route.name === 'library' || route.name === 'settings' ? ' wide' : ''}`}>
        <Suspense fallback={<Loading />}>{content}</Suspense>
      </div>
    </div>
  );
}

/** Floating pen/lasso toolbar for the Desk (hidden on routes without ink). */
function InkDock() {
  const route = useUI((s) => s.route.name);
  if (route !== 'stream' && route !== 'page' && route !== 'lens') return null;
  return (
    <div className="ink-dock">
      <InkToolbar />
    </div>
  );
}

/** Split-brain workspace: Library (reader) on the left, Desk on the right, Side-Quest panel. */
function Workspace() {
  const reader = useUI((s) => s.reader);
  const ratio = useUI((s) => s.splitRatio);
  const setRatio = useUI((s) => s.setSplitRatio);
  const mobilePane = useUI((s) => s.mobilePane);
  const sideOpen = useUI((s) => s.sideQuest.open);
  const panes = useRef<HTMLDivElement>(null);

  const startDrag = (e: React.PointerEvent) => {
    const el = panes.current;
    if (!el) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => setRatio((ev.clientX - rect.left) / rect.width);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={panes} className={`panes${reader ? ' split' : ''}${sideOpen ? ' with-side' : ''}`} data-mobile-pane={mobilePane}>
      {reader && (
        <>
          <section className="pane pane-reader" style={{ flexBasis: `${ratio * 100}%` }} aria-label="Source Vault">
            <Suspense fallback={<Loading />}>
              <ReaderPane key={reader.sourceId} />
            </Suspense>
          </section>
          <div className="pane-divider" onPointerDown={startDrag} onDoubleClick={() => setRatio(0.5)} role="separator" aria-orientation="vertical" aria-label="Resize panes" />
        </>
      )}
      <section className="pane pane-desk" aria-label="Active Desk">
        <DeskContent />
        <InkDock />
      </section>
      {sideOpen && <SideQuest />}
    </div>
  );
}

export function App() {
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  useGlobalShortcuts();
  useInkShortcuts();

  useEffect(() => {
    document.getElementById('root')?.classList.add('ready');
  }, []);

  return (
    <EditorEnvProvider>
      <div className={`app${sidebarOpen ? ' sidebar-open' : ''}`}>
        <Sidebar />
        <main className="main">
          <Topbar />
          <Workspace />
        </main>
        <Palette />
        <Toasts />
        <GlobalDrop />
        <AIBridgeDialog />
      </div>
    </EditorEnvProvider>
  );
}
