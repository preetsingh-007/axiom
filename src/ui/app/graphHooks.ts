import { useEffect, useReducer } from 'react';
import { useServices } from './services';
import type { AppServices } from './bootstrap';

/** Bumps whenever the derived graph index changes (debounced by the index). */
export function useGraphVersion(): number {
  const { graph } = useServices() as AppServices;
  const [v, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => graph.onChange.on(() => bump()), [graph]);
  return v;
}

export function useGraph() {
  return (useServices() as AppServices).graph;
}
