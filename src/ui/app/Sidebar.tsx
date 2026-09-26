import { memo, useMemo } from 'react';
import { CalendarDays, Library, Layers, Network, Settings as SettingsIcon, Plus, Telescope, FileText, Presentation, Sparkles } from 'lucide-react';
import { useUI, type Route } from './store';
import { useServices } from './services';
import { useYSelect } from '../hooks/useY';
import type { Lens } from '../../core/schema';
import { createNote } from './actions';
import { SyncBadge } from './SyncBadge';
import { useDueCount } from './reviewHooks';

function NavItem({ route, icon, label, badge, active }: { route: Route; icon: React.ReactNode; label: string; badge?: number; active: boolean }) {
  const navigate = useUI((s) => s.navigate);
  return (
    <button className={`nav-item${active ? ' active' : ''}`} onClick={() => navigate(route)} aria-current={active ? 'page' : undefined}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {!!badge && <span className="nav-badge">{badge > 999 ? '999+' : badge}</span>}
    </button>
  );
}

export const Sidebar = memo(function Sidebar() {
  const { vault } = useServices();
  const route = useUI((s) => s.route);
  const navigate = useUI((s) => s.navigate);
  const toggle = useUI((s) => s.toggleSidebar);
  const due = useDueCount();

  const recentKey = useYSelect(
    vault.pages,
    (pages) => {
      const list: [number, string, string, string][] = [];
      for (const m of pages.values()) {
        if (m.get('trashed') || m.get('kind') === 'daily' || m.get('kind') === 'sidequest') continue;
        list.push([(m.get('updatedAt') as number) ?? 0, m.get('id') as string, m.get('title') as string, m.get('kind') as string]);
      }
      list.sort((a, b) => b[0] - a[0]);
      return JSON.stringify(list.slice(0, 12).map((x) => [x[1], x[2], x[3]]));
    },
    { deep: true },
  );
  const recent = useMemo(() => JSON.parse(recentKey ?? '[]') as [string, string, string][], [recentKey]);
  const lensesKey = useYSelect(vault.lenses, (l) => JSON.stringify([...l.values()].sort((a, b) => a.createdAt - b.createdAt)));
  const lenses = useMemo(() => JSON.parse(lensesKey ?? '[]') as Lens[], [lensesKey]);

  const is = (name: Route['name']) => route.name === name;

  return (
    <>
      <div className="sidebar-scrim" onClick={() => toggle(false)} aria-hidden />
      <nav className="sidebar" aria-label="Main">
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden>
            A
          </div>
          <span className="brand-name">Axiom</span>
        </div>
        <div className="nav-group">
          <NavItem route={{ name: 'stream' }} icon={<CalendarDays size={17} />} label="Daily Stream" active={is('stream')} />
          <NavItem route={{ name: 'library' }} icon={<Library size={17} />} label="Library" active={is('library')} />
          <NavItem route={{ name: 'review' }} icon={<Layers size={17} />} label="Review" badge={due} active={is('review')} />
          <NavItem route={{ name: 'graph' }} icon={<Network size={17} />} label="Graph" active={is('graph')} />
        </div>

        <div className="nav-section">
          <div className="nav-section-head">
            <span>Lenses</span>
            <button className="nav-add" title="New lens" aria-label="New lens" onClick={() => navigate({ name: 'lens' })}>
              <Plus size={14} />
            </button>
          </div>
          {lenses.length === 0 && (
            <button className="nav-item subtle" onClick={() => navigate({ name: 'lens' })}>
              <span className="nav-icon">
                <Telescope size={16} />
              </span>
              <span className="nav-label">Create a lens…</span>
            </button>
          )}
          {lenses.map((l) => (
            <NavItem key={l.id} route={{ name: 'lens', lensId: l.id }} icon={<Telescope size={16} />} label={l.name} active={route.name === 'lens' && route.lensId === l.id} />
          ))}
        </div>

        <div className="nav-section grow">
          <div className="nav-section-head">
            <span>Pages</span>
            <button className="nav-add" title="New note" aria-label="New note" onClick={() => createNote()}>
              <Plus size={14} />
            </button>
          </div>
          {recent.map(([id, title, kind]) => (
            <NavItem
              key={id}
              route={{ name: 'page', pageId: id }}
              icon={kind === 'seminar' ? <Presentation size={15} /> : kind === 'concept' ? <Sparkles size={15} /> : <FileText size={15} />}
              label={title || 'Untitled'}
              active={route.name === 'page' && route.pageId === id}
            />
          ))}
        </div>

        <div className="sidebar-foot">
          <SyncBadge />
          <NavItem route={{ name: 'settings' }} icon={<SettingsIcon size={17} />} label="Settings" active={is('settings')} />
        </div>
      </nav>
    </>
  );
});
