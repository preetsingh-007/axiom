import { useEffect, useState } from 'react';
import { X, Search, ArrowUpRight, NotebookPen } from 'lucide-react';
import { useUI } from '../app/store';
import { useServices } from '../app/services';
import { PageView } from './PageView';
import { isoDate } from '../../core/util/ids';
import { resolvePage } from '../app/actions';
import { usePageMeta } from '../hooks/usePage';

/**
 * The Side-Quest Panel: a temporary right-hand scratchpad for looking up a citation or
 * unknown concept without losing your place in the main reading/writing view.
 */
export function SideQuest() {
  const { vault } = useServices();
  const pageId = useUI((s) => s.sideQuest.pageId);
  const open = useUI((s) => s.openSideQuest);
  const close = useUI((s) => s.closeSideQuest);
  const navigate = useUI((s) => s.navigate);
  const [q, setQ] = useState('');

  // default: today's side-quest scratchpad
  useEffect(() => {
    if (!pageId) {
      const date = isoDate();
      const id = vault.createPage({ id: `sq-${date}`, title: `Side quests · ${date}`, kind: 'sidequest', date });
      open(id);
    }
  }, [pageId, vault, open]);

  const meta = usePageMeta(pageId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest?.('.cm-editor, input, [contenteditable="true"]')) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <aside className="sidequest" aria-label="Side-quest panel">
      <div className="sq-head">
        <NotebookPen size={16} className="sq-icon" />
        <form
          className="sq-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) {
              open(resolvePage(q.trim()));
              setQ('');
            }
          }}
        >
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Look up a concept or citation…" aria-label="Look up concept" />
        </form>
        {meta && meta.kind !== 'sidequest' && (
          <button className="ui-icon-btn" title="Open in main view" aria-label="Open in main view" onClick={() => navigate({ name: 'page', pageId: meta.id })}>
            <ArrowUpRight size={16} />
          </button>
        )}
        <button className="ui-icon-btn" onClick={close} title="Close (Esc)" aria-label="Close side-quest panel">
          <X size={17} />
        </button>
      </div>
      <div className="sq-body">
        {meta && meta.kind !== 'sidequest' && (
          <button className="sq-back" onClick={() => open(`sq-${isoDate()}`)}>
            ← Back to today's side quests
          </button>
        )}
        {pageId && <PageView key={pageId} pageId={pageId} compact />}
      </div>
    </aside>
  );
}
