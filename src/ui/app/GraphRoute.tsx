import { GraphView } from '../graph/GraphView';
import { useServices } from './services';
import type { AppServices } from './bootstrap';
import { useUI } from './store';

export function GraphRoute({ focus }: { focus?: string }) {
  const { graph } = useServices() as AppServices;
  const navigate = useUI((s) => s.navigate);
  return (
    <div className="graph-route">
      <GraphView index={graph} focusPageId={focus} onOpenPage={(pageId: string) => navigate({ name: 'page', pageId })} />
    </div>
  );
}
