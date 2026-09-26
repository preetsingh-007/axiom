import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Link2 } from 'lucide-react';
import type { Vault } from '../../core/vault';
import type { BlockHit, GraphIndex, MentionHit } from '../../core/graph/index';
import { linkMention } from '../../core/graph/merge';
import './graph.css';

export interface BacklinksPanelProps {
  index: GraphIndex;
  vault: Vault;
  pageId: string;
  /** opens a page (optionally scrolled to a block) */
  onOpenPage(pageId: string, blockId?: string): void;
  /** custom rendering of a referencing block (e.g. a live transclusion); defaults to the plain snippet */
  renderSnippet?(hit: BlockHit): ReactNode;
}

function groupByPage<T extends BlockHit>(hits: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const h of hits) {
    const g = groups.get(h.pageId);
    if (g) g.push(h);
    else groups.set(h.pageId, [h]);
  }
  return [...groups];
}

/** Re-renders when the graph index reports changes (including page renames / trash). */
function useIndexVersion(index: GraphIndex): number {
  const [version, setVersion] = useState(0);
  useEffect(() => index.onChange.on(() => setVersion((v) => v + 1)), [index]);
  return version;
}

/**
 * Linked references (grouped by page) and collapsible unlinked mentions for a page.
 * "Link" turns a plain-text mention into `[[…]]` in the source block.
 */
export function BacklinksPanel({ index, vault, pageId, onOpenPage, renderSnippet }: BacklinksPanelProps) {
  const version = useIndexVersion(index);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [linking, setLinking] = useState<Set<string>>(() => new Set());

  const linked = useMemo(() => groupByPage(index.backlinks(pageId)), [index, pageId, version]);
  const unlinked = useMemo(
    () => (showUnlinked ? groupByPage(index.unlinkedMentions(pageId)) : []),
    [index, pageId, showUnlinked, version],
  );
  const linkedCount = linked.reduce((n, [, hits]) => n + hits.length, 0);
  const unlinkedCount = unlinked.reduce((n, [, hits]) => n + hits.length, 0);

  useEffect(() => setLinking(new Set()), [version]);

  const doLink = async (hit: MentionHit) => {
    const key = hit.pageId + '\u0000' + hit.blockId;
    setLinking((s) => new Set(s).add(key));
    const ok = await linkMention(vault, hit.pageId, hit.blockId, hit.phrase);
    if (!ok) {
      setLinking((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };

  const pageTitle = (id: string) => index.pageTitle(id) ?? 'Untitled';

  return (
    <section className="gv-backlinks" aria-label="References">
      <div>
        <h3 className="gv-bl-section-title">
          Linked references <span className="gv-bl-count">{linkedCount}</span>
        </h3>
        {linked.length === 0 && <p className="gv-bl-empty">No pages link here yet.</p>}
        {linked.map(([pid, hits]) => (
          <div className="gv-bl-group" key={pid}>
            <button type="button" className="gv-bl-page" onClick={() => onOpenPage(pid)}>
              {pageTitle(pid)}
            </button>
            {hits.map((h) => (
              <div className="gv-bl-item" key={h.blockId}>
                {renderSnippet ? (
                  <div className="gv-bl-snippet">{renderSnippet(h)}</div>
                ) : (
                  <button type="button" className="gv-bl-snippet" onClick={() => onOpenPage(h.pageId, h.blockId)}>
                    {h.snippet || '(empty block)'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div>
        <h3 className="gv-bl-section-title">
          <button type="button" className="gv-bl-toggle" aria-expanded={showUnlinked} onClick={() => setShowUnlinked((v) => !v)}>
            {showUnlinked ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            Unlinked mentions
          </button>
          {showUnlinked && <span className="gv-bl-count">{unlinkedCount}</span>}
        </h3>
        {showUnlinked && unlinked.length === 0 && <p className="gv-bl-empty">No unlinked mentions.</p>}
        {unlinked.map(([pid, hits]) => (
          <div className="gv-bl-group" key={pid}>
            <button type="button" className="gv-bl-page" onClick={() => onOpenPage(pid)}>
              {pageTitle(pid)}
            </button>
            {hits.map((h) => {
              const busy = linking.has(h.pageId + '\u0000' + h.blockId);
              return (
                <div className="gv-bl-item" key={h.blockId}>
                  <button type="button" className="gv-bl-snippet" onClick={() => onOpenPage(h.pageId, h.blockId)}>
                    {h.snippet}
                  </button>
                  <button
                    type="button"
                    className="gv-bl-link"
                    disabled={busy}
                    onClick={() => void doLink(h)}
                    title={`Turn "${h.phrase}" into a link`}
                  >
                    <Link2 size={12} aria-hidden="true" />
                    {busy ? 'Linked' : 'Link'}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
