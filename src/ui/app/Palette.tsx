import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, FileText, CalendarDays, Library, Layers, Network, Settings, Plus, Moon, Columns2, NotebookPen, Telescope, BookOpen, CornerDownLeft } from 'lucide-react';
import { useUI } from './store';
import { useServices } from './services';
import type { AppServices } from './bootstrap';
import { createNote, openPageByTitle } from './actions';
import { renderInline } from '../markdown/render';

interface Item {
  key: string;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  html?: string;
  run: () => void;
}

/** ⌘K command palette: fuzzy search over pages, blocks, sources and commands. */
export function Palette() {
  const open = useUI((s) => s.paletteOpen);
  const setOpen = useUI((s) => s.setPalette);
  if (!open) return null;
  return <PaletteInner onClose={() => setOpen(false)} />;
}

function PaletteInner({ onClose }: { onClose: () => void }) {
  const services = useServices() as AppServices;
  const ui = useUI.getState();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  const commands: Item[] = useMemo(
    () => [
      { key: 'c:today', icon: <CalendarDays size={16} />, title: 'Go to Daily Stream', run: () => ui.navigate({ name: 'stream' }) },
      { key: 'c:new', icon: <Plus size={16} />, title: 'New note', subtitle: 'Ctrl+Alt+N', run: () => createNote() },
      { key: 'c:lib', icon: <Library size={16} />, title: 'Open Library', run: () => ui.navigate({ name: 'library' }) },
      { key: 'c:review', icon: <Layers size={16} />, title: 'Review flashcards', run: () => ui.navigate({ name: 'review' }) },
      { key: 'c:graph', icon: <Network size={16} />, title: 'Open knowledge graph', run: () => ui.navigate({ name: 'graph' }) },
      { key: 'c:lens', icon: <Telescope size={16} />, title: 'New lens (dynamic workspace)', run: () => ui.navigate({ name: 'lens' }) },
      { key: 'c:side', icon: <NotebookPen size={16} />, title: 'Toggle side-quest panel', subtitle: 'Ctrl+.', run: () => (ui.sideQuest.open ? ui.closeSideQuest() : ui.openSideQuest()) },
      { key: 'c:split', icon: <Columns2 size={16} />, title: 'Close split view', run: () => ui.closeReader() },
      { key: 'c:theme', icon: <Moon size={16} />, title: 'Toggle dark mode', run: () => ui.setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') },
      { key: 'c:settings', icon: <Settings size={16} />, title: 'Settings — sync, AI, citations', run: () => ui.navigate({ name: 'settings' }) },
    ],
    [ui],
  );

  const items: Item[] = useMemo(() => {
    const query = q.trim();
    if (!query) {
      const recent = services.vault
        .listPages()
        .filter((p) => p.kind !== 'sidequest')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6)
        .map<Item>((p) => ({ key: 'p:' + p.id, icon: p.kind === 'daily' ? <CalendarDays size={16} /> : <FileText size={16} />, title: p.title, subtitle: 'Recent', run: () => ui.navigate({ name: 'page', pageId: p.id }) }));
      return [...recent, ...commands];
    }
    const lower = query.toLowerCase();
    const out: Item[] = [];
    const seenPages = new Set<string>();
    // page title matches first
    const pages = services.vault
      .listPages()
      .filter((p) => p.title.toLowerCase().includes(lower))
      .sort((a, b) => Number(b.title.toLowerCase().startsWith(lower)) - Number(a.title.toLowerCase().startsWith(lower)) || b.updatedAt - a.updatedAt)
      .slice(0, 8);
    for (const p of pages) {
      seenPages.add(p.id);
      out.push({ key: 'p:' + p.id, icon: p.kind === 'daily' ? <CalendarDays size={16} /> : <FileText size={16} />, title: p.title, subtitle: p.kind, run: () => ui.navigate({ name: 'page', pageId: p.id }) });
    }
    for (const s of services.vault.listSources()) {
      const hay = `${s.title} ${s.bib?.authors?.join(' ') ?? ''} ${s.bib?.bibKey ?? ''}`.toLowerCase();
      if (hay.includes(lower)) out.push({ key: 's:' + s.id, icon: <BookOpen size={16} />, title: s.title, subtitle: s.bib?.bibKey ?? s.kind.toUpperCase(), run: () => ui.openReader(s.id) });
      if (out.length > 14) break;
    }
    for (const hit of services.graph.search(query, { limit: 20 })) {
      if (!hit.blockId && seenPages.has(hit.pageId)) continue;
      out.push({
        key: `b:${hit.pageId}:${hit.blockId ?? ''}`,
        icon: <FileText size={16} />,
        title: hit.title,
        html: renderInline(hit.snippet ?? ''),
        run: () => ui.navigate({ name: 'page', pageId: hit.pageId, blockId: hit.blockId }),
      });
    }
    for (const c of commands) if (c.title.toLowerCase().includes(lower)) out.push(c);
    if (!services.vault.findPageByTitle(query)) {
      out.push({ key: 'new', icon: <Plus size={16} />, title: `Create page “${query}”`, run: () => openPageByTitle(query) });
    }
    return out;
  }, [q, services, commands, ui]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.run();
  };

  return (
    <div className="ui-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ui-modal palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Search size={17} />
          <input
            ref={input}
            value={q}
            placeholder="Search notes, papers, commands…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(active);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            aria-label="Search"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `pi-${active}` : undefined}
          />
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {items.map((it, i) => (
            <div key={it.key} id={`pi-${i}`} role="option" aria-selected={i === active} className={`palette-item${i === active ? ' active' : ''}`} onMouseMove={() => setActive(i)} onClick={() => run(i)}>
              <span className="palette-icon">{it.icon}</span>
              <span className="palette-text">
                <span className="palette-title">{it.title}</span>
                {it.html ? <span className="palette-sub" dangerouslySetInnerHTML={{ __html: it.html }} /> : it.subtitle ? <span className="palette-sub">{it.subtitle}</span> : null}
              </span>
              {i === active && <CornerDownLeft size={14} className="palette-enter" />}
            </div>
          ))}
          {items.length === 0 && <div className="palette-empty">No results</div>}
        </div>
      </div>
    </div>
  );
}
