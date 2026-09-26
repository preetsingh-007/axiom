import { BacklinksPanel } from '../graph/BacklinksPanel';
import { useServices } from '../app/services';
import type { AppServices } from '../app/bootstrap';
import { useUI } from '../app/store';

/** Linked references + unlinked mentions under a page. */
export function Backlinks({ pageId }: { pageId: string }) {
  const { graph, vault } = useServices() as AppServices;
  const navigate = useUI((s) => s.navigate);
  return (
    <div className="backlinks-wrap">
      <BacklinksPanel index={graph} vault={vault} pageId={pageId} onOpenPage={(p, b) => navigate({ name: 'page', pageId: p, blockId: b })} />
    </div>
  );
}
