import type { AppServices } from './bootstrap';
import { findMergeCandidates } from '../../core/graph/similarity';
import { dismissMerge, dismissedPairs, mergeConcepts } from '../../core/graph/merge';
import { useUI } from './store';

const FIRST_RUN_MS = 45_000;
const INTERVAL_MS = 10 * 60_000;

/**
 * Background knowledge-graph maintenance: periodically looks for duplicate / near-duplicate
 * tags and concepts (RL ↔ Reinforcement Learning, MDPs ↔ MDP) and prompts to merge them.
 */
export function startMaintenance(services: AppServices) {
  const { vault, graph } = services;
  const asked = new Set<string>();
  const run = () => {
    if (document.visibilityState !== 'visible' || !graph.ready) return;
    const ui = useUI.getState();
    if (ui.toasts.length) return;
    const candidates = findMergeCandidates(graph.concepts(), dismissedPairs(vault), { limit: 5, minScore: 0.9 });
    const c = candidates.find((x) => !asked.has(`${x.a}|${x.b}`));
    if (!c) return;
    asked.add(`${c.a}|${c.b}`);
    ui.toast({
      message: `Tidy up: merge “${c.a}” into “${c.b}”?`,
      timeout: 15_000,
      action: {
        label: 'Merge',
        run: () =>
          void mergeConcepts(vault, graph, c.a, c.b).then(
            (r) => useUI.getState().toast({ message: `Merged — ${r.occurrences} reference${r.occurrences === 1 ? "" : "s"} updated`, kind: "success" }),
            (e) => useUI.getState().toast({ message: String(e?.message ?? e), kind: 'error' }),
          ),
      },
      secondary: { label: 'Keep both', run: () => dismissMerge(vault, c.a, c.b) },
    });
  };
  setTimeout(run, FIRST_RUN_MS);
  setInterval(run, INTERVAL_MS);
}
