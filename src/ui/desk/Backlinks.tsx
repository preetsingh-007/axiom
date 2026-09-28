import { useMemo } from 'react';
import { BacklinksPanel } from '../graph/BacklinksPanel';
import { useServices } from '../app/services';
import type { AppServices } from '../app/bootstrap';
import { useUI } from '../app/store';
import { usePageDoc } from '../hooks/usePage';
import { getBlock } from '../../core/blocks';
import { PageEditorApi, PageEditorContext } from './editorContext';
import { BlockRow } from './BlockRow';

/** A referencing block rendered live (math, links, images) and editable in place. */
function BacklinkBlock({ pageId, blockId, fallback }: { pageId: string; blockId: string; fallback: string }) {
  const doc = usePageDoc(pageId);
  const api = useMemo(() => (doc ? new PageEditorApi(pageId, doc, false, [blockId]) : null), [doc, pageId, blockId]);
  if (!doc || !api || !getBlock(doc, blockId)) return <span>{fallback}</span>;
  return (
    <PageEditorContext.Provider value={api}>
      <div className="backlink-block">
        <BlockRow id={blockId} index={0} compact />
      </div>
    </PageEditorContext.Provider>
  );
}

/** Linked references + unlinked mentions under a page. */
export function Backlinks({ pageId }: { pageId: string }) {
  const { graph, vault } = useServices() as AppServices;
  const navigate = useUI((s) => s.navigate);
  return (
    <div className="backlinks-wrap">
      <BacklinksPanel
        index={graph}
        vault={vault}
        pageId={pageId}
        onOpenPage={(p, b) => navigate({ name: 'page', pageId: p, blockId: b })}
        renderSnippet={(hit) => <BacklinkBlock pageId={hit.pageId} blockId={hit.blockId} fallback={hit.snippet} />}
      />
    </div>
  );
}
