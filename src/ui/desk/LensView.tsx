import { memo, useEffect, useMemo, useState } from 'react';
import { Telescope, Save, Trash2, HelpCircle, ArrowUpRight } from 'lucide-react';
import { useServices } from '../app/services';
import type { AppServices } from '../app/bootstrap';
import { useUI } from '../app/store';
import { runLens, LENS_HELP, type LensResult } from '../../core/graph/lens';
import { useGraphVersion } from '../app/graphHooks';
import { usePageDoc } from '../hooks/usePage';
import { PageEditorApi, PageEditorContext } from './editorContext';
import { BlockRow } from './BlockRow';
import { getBlock } from '../../core/blocks';
import { uid } from '../../core/util/ids';
import { useYSelect } from '../hooks/useY';
import type { Lens } from '../../core/schema';

const EXAMPLES = ['[[Reinforcement Learning]]', 'is:flashcard', 'type:math', 'has:anchor after:2026-01-01', '#todo -#done'];
const MAX_RESULTS = 400;

/**
 * Dynamic Workspaces ("Lenses"): live, editable aggregations of blocks from across the whole
 * vault, e.g. `[[Reinforcement Learning]] OR source:"Paper A" OR source:"Paper B"`.
 */
export function LensView({ lensId, initialQuery }: { lensId?: string; initialQuery?: string }) {
  const { vault, graph } = useServices() as AppServices;
  const navigate = useUI((s) => s.navigate);
  const toast = useUI((s) => s.toast);
  const saved = useYSelect(vault.lenses, (m) => (lensId ? m.get(lensId) : undefined)) as Lens | undefined;
  const [name, setName] = useState(saved?.name ?? '');
  const [query, setQuery] = useState(saved?.query ?? initialQuery ?? '');
  const [debounced, setDebounced] = useState(query);
  const [help, setHelp] = useState(false);
  const version = useGraphVersion();

  useEffect(() => {
    setName(saved?.name ?? '');
    setQuery(saved?.query ?? initialQuery ?? '');
    setDebounced(saved?.query ?? initialQuery ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lensId]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 220);
    return () => clearTimeout(t);
  }, [query]);

  const { results, errors } = useMemo(() => (debounced.trim() ? runLens(graph, vault, debounced) : { results: [] as LensResult[], errors: [] as string[] }), [debounced, graph, vault, version]);

  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of results.slice(0, MAX_RESULTS)) {
      const list = map.get(r.pageId);
      if (list) list.push(r.blockId);
      else map.set(r.pageId, [r.blockId]);
    }
    return [...map];
  }, [results]);

  const save = () => {
    const id = lensId ?? 'l-' + uid(8);
    const lens: Lens = { id, name: name.trim() || query.trim().slice(0, 40) || 'Untitled lens', query, createdAt: saved?.createdAt ?? Date.now() };
    vault.transact(() => vault.lenses.set(id, lens));
    if (!lensId) navigate({ name: 'lens', lensId: id }, { replace: true });
    toast({ message: 'Lens saved', kind: 'success' });
  };

  const remove = () => {
    if (!lensId) return;
    vault.transact(() => vault.lenses.delete(lensId));
    navigate({ name: 'stream' });
  };

  return (
    <div className="lens">
      <div className="lens-head">
        <div className="page-kind">
          <Telescope size={12} style={{ verticalAlign: '-1px' }} /> Lens
        </div>
        <input className="lens-name" placeholder="Untitled lens" value={name} onChange={(e) => setName(e.target.value)} aria-label="Lens name" />
        <div className="lens-query-row">
          <input
            className="ui-input lens-query"
            placeholder='e.g. [[Reinforcement Learning]] OR source:"Sutton & Barto"'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Lens query"
            autoFocus={!lensId}
          />
          <button className="ui-icon-btn" aria-pressed={help} onClick={() => setHelp(!help)} title="Query syntax" aria-label="Query syntax">
            <HelpCircle size={17} />
          </button>
          <button className="ui-btn" onClick={save} disabled={!query.trim()}>
            <Save size={14} /> {lensId ? 'Update' : 'Save'}
          </button>
          {lensId && (
            <button className="ui-icon-btn" onClick={remove} title="Delete lens" aria-label="Delete lens">
              <Trash2 size={16} />
            </button>
          )}
        </div>
        {help && <pre className="lens-help">{LENS_HELP}</pre>}
        {!query.trim() && (
          <div className="lens-examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="ui-chip" onClick={() => setQuery(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}
        {errors.length > 0 && <div className="lens-errors">{errors.join(' · ')}</div>}
        {debounced.trim() && (
          <div className="lens-count">
            {results.length} block{results.length === 1 ? '' : 's'} across {groups.length} page{groups.length === 1 ? '' : 's'}
            {results.length > MAX_RESULTS && ` (showing first ${MAX_RESULTS})`}
          </div>
        )}
      </div>
      {groups.map(([pageId, blockIds]) => (
        <LensGroup key={pageId} pageId={pageId} blockIds={blockIds} />
      ))}
    </div>
  );
}

const LensGroup = memo(function LensGroup({ pageId, blockIds }: { pageId: string; blockIds: string[] }) {
  const { vault } = useServices();
  const navigate = useUI((s) => s.navigate);
  const doc = usePageDoc(pageId);
  const api = useMemo(() => (doc ? new PageEditorApi(pageId, doc) : null), [doc, pageId]);
  const title = vault.getPage(pageId)?.title ?? 'Untitled';
  return (
    <section className="lens-group">
      <button className="lens-group-title" onClick={() => navigate({ name: 'page', pageId })}>
        {title} <ArrowUpRight size={13} />
      </button>
      {api && doc && (
        <PageEditorContext.Provider value={api}>
          <div className="lens-blocks">{blockIds.map((id, i) => (getBlock(doc, id) ? <BlockRow key={id} id={id} index={i} /> : null))}</div>
        </PageEditorContext.Provider>
      )}
    </section>
  );
});
