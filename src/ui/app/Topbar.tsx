import { PanelLeft, Search, Columns2, NotebookPen, Moon, Sun, BookOpen, PenLine } from 'lucide-react';
import { useUI } from './store';
import { useServices } from './services';
import { useYSelect } from '../hooks/useY';

function useRouteTitle(): string {
  const { vault } = useServices();
  const route = useUI((s) => s.route);
  const pageTitle = useYSelect(vault.pages, (p) => (route.name === 'page' ? ((p.get(route.pageId)?.get('title') as string) ?? '') : ''), { deep: true });
  switch (route.name) {
    case 'stream':
      return 'Daily Stream';
    case 'page':
      return pageTitle ?? '';
    case 'library':
      return 'Library';
    case 'lens':
      return 'Lens';
    case 'graph':
      return 'Graph';
    case 'review':
      return 'Review';
    case 'settings':
      return 'Settings';
  }
}

export function Topbar() {
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const setPalette = useUI((s) => s.setPalette);
  const reader = useUI((s) => s.reader);
  const closeReader = useUI((s) => s.closeReader);
  const navigate = useUI((s) => s.navigate);
  const side = useUI((s) => s.sideQuest.open);
  const openSide = useUI((s) => s.openSideQuest);
  const closeSide = useUI((s) => s.closeSideQuest);
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const mobilePane = useUI((s) => s.mobilePane);
  const setMobilePane = useUI((s) => s.setMobilePane);
  const title = useRouteTitle();
  const isDark = document.documentElement.dataset.theme === 'dark';

  return (
    <header className="topbar">
      <button className="ui-icon-btn" onClick={() => toggleSidebar()} title="Toggle sidebar (Ctrl+\\)" aria-label="Toggle sidebar">
        <PanelLeft size={18} />
      </button>
      <div className="topbar-title" title={title}>
        {title}
      </div>
      {reader && (
        <div className="pane-switch" role="tablist" aria-label="Visible pane">
          <button role="tab" aria-selected={mobilePane === 'reader'} className={mobilePane === 'reader' ? 'active' : ''} onClick={() => setMobilePane('reader')}>
            <BookOpen size={15} /> Source
          </button>
          <button role="tab" aria-selected={mobilePane === 'desk'} className={mobilePane === 'desk' ? 'active' : ''} onClick={() => setMobilePane('desk')}>
            <PenLine size={15} /> Desk
          </button>
        </div>
      )}
      <button className="topbar-search" onClick={() => setPalette(true)} aria-label="Search">
        <Search size={15} />
        <span>Search or jump to…</span>
        <kbd className="ui-kbd">⌘K</kbd>
      </button>
      <div className="topbar-actions">
        <button
          className="ui-icon-btn"
          aria-pressed={!!reader}
          title={reader ? 'Close source (split view)' : 'Open the Library side by side'}
          aria-label="Toggle split view"
          onClick={() => (reader ? closeReader() : navigate({ name: 'library' }))}
        >
          <Columns2 size={18} />
        </button>
        <button className="ui-icon-btn" aria-pressed={side} title="Side-quest scratchpad (Ctrl+.)" aria-label="Toggle side-quest panel" onClick={() => (side ? closeSide() : openSide())}>
          <NotebookPen size={18} />
        </button>
        <button className="ui-icon-btn" title="Toggle theme" aria-label="Toggle theme" onClick={() => setTheme(isDark ? 'light' : theme === 'light' ? 'dark' : isDark ? 'light' : 'dark')}>
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
}
