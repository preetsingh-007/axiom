import { useMemo } from 'react';
import { ReviewView } from '../review/ReviewView';
import { useServices } from './services';
import { useUI } from './store';
import { usePageDoc } from '../hooks/usePage';
import { getBlock } from '../../core/blocks';
import { BlockRow } from '../desk/BlockRow';
import { PageEditorApi, PageEditorContext } from '../desk/editorContext';
import { srsOptions } from './reviewHooks';
import type { Anchor } from '../../core/schema';

/** Read-only rendering of one block (used as the answer of basic cards). */
function ReadOnlyBlock({ pageId, blockId }: { pageId: string; blockId: string }) {
  const doc = usePageDoc(pageId);
  const api = useMemo(() => (doc ? new PageEditorApi(pageId, doc, true) : null), [doc, pageId]);
  if (!doc || !api || !getBlock(doc, blockId)) return null;
  return (
    <PageEditorContext.Provider value={api}>
      <div className="review-block">
        <BlockRow id={blockId} index={0} readOnly compact />
      </div>
    </PageEditorContext.Provider>
  );
}

export function ReviewRoute() {
  const { vault } = useServices();
  const openReader = useUI((s) => s.openReader);
  const navigate = useUI((s) => s.navigate);
  const options = useMemo(() => srsOptions(vault), [vault]);
  return (
    <div className="review-route">
      <ReviewView
        vault={vault}
        renderBlock={(p, b) => <ReadOnlyBlock pageId={p} blockId={b} />}
        onOpenAnchor={(a: Anchor) => openReader(a.sourceId, { loc: a.loc, flash: true })}
        onOpenPage={(pageId: string, blockId?: string) => navigate({ name: 'page', pageId, blockId })}
        options={options}
      />
    </div>
  );
}
