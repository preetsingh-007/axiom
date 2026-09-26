import { useMemo } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useServices } from '../../app/services';
import { usePageDoc, useBlockIds } from '../../hooks/usePage';
import { useYSelect } from '../../hooks/useY';
import { getBlock } from '../../../core/blocks';
import { BlockRow } from '../BlockRow';
import { PageEditorApi, PageEditorContext, useEditorEnv } from '../editorContext';
import type { PageMeta } from '../../../core/schema';

/**
 * Inline, live, editable view of another page (or one of its blocks): ![[Page]] / ![[Page#^id]].
 */
export function Transclusion({ title, pageId: givenPageId, blockId }: { title?: string; pageId?: string; blockId?: string }) {
  const { vault } = useServices();
  const env = useEditorEnv();
  // re-resolve when pages are added (e.g. the target is created later or arrives via sync)
  const pageId = useYSelect(vault.pages, () => givenPageId ?? (title ? vault.findPageByTitle(title)?.id : undefined));
  const meta = pageId ? (vault.pages.get(pageId)?.toJSON() as PageMeta | undefined) : undefined;
  const doc = usePageDoc(pageId);
  const ids = useBlockIds(doc);
  const api = useMemo(() => (doc && pageId ? new PageEditorApi(pageId, doc) : null), [doc, pageId]);

  if (!pageId) {
    return (
      <span className="tx tx-missing" contentEditable={false}>
        <button className="ui-btn small ghost" onClick={() => title && env.openPage(title)}>
          Create “{title}”
        </button>
      </span>
    );
  }
  const shown = blockId ? ids.filter((id) => id === blockId) : ids;
  return (
    <div className="tx" contentEditable={false} onClick={(e) => e.stopPropagation()}>
      <div className="tx-head">
        <button className="tx-title" onClick={() => env.openPage(meta?.title ?? title ?? '')} title="Open page">
          {meta?.title ?? title}
          <ArrowUpRight size={13} />
        </button>
      </div>
      {api && doc && (
        <PageEditorContext.Provider value={api}>
          <div className="tx-body">
            {shown.length === 0 && <div className="tx-empty">{blockId ? 'Block not found' : 'Empty page'}</div>}
            {shown.map((id, i) => (getBlock(doc, id) ? <BlockRow key={id} id={id} index={i} compact /> : null))}
          </div>
        </PageEditorContext.Provider>
      )}
    </div>
  );
}
