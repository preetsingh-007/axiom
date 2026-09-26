/** Pure helpers for the graph view (kept separate from the canvas component for testing). */

import type { GraphData, GraphNode, GraphNodeKind } from '../../core/graph/index';
import { fold } from '../../core/graph/tokenize';

/** The `hops`-neighbourhood of `focusId` (edges treated as undirected). */
export function localSubgraph(data: GraphData, focusId: string, hops = 2): GraphData {
  const adj = new Map<string, string[]>();
  for (const l of data.links) {
    (adj.get(l.source) ?? adj.set(l.source, []).get(l.source)!).push(l.target);
    (adj.get(l.target) ?? adj.set(l.target, []).get(l.target)!).push(l.source);
  }
  const keep = new Set<string>([focusId]);
  let frontier = [focusId];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (keep.has(n)) continue;
        keep.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return {
    nodes: data.nodes.filter((n) => keep.has(n.id)),
    links: data.links.filter((l) => keep.has(l.source) && keep.has(l.target)),
  };
}

/** Node radius in world units from its weight. */
export function nodeRadius(weight: number): number {
  return Math.min(22, 3 + 1.8 * Math.sqrt(Math.max(0, weight - 1)));
}

/**
 * Minimum weight for a node label at zoom `k`: roughly the top `budget × k²` nodes get labels,
 * so zooming in reveals more. `sortedDesc` are node weights sorted descending.
 */
export function labelMinWeight(sortedDesc: number[], k: number, budget = 30): number {
  if (!sortedDesc.length) return Infinity;
  const idx = Math.min(sortedDesc.length - 1, Math.floor(budget * k * k));
  return Math.max(sortedDesc[idx], 2);
}

/** Ids of nodes whose title contains the query (case / diacritics-insensitive). */
export function matchNodes(nodes: GraphNode[], query: string): Set<string> {
  const q = fold(query.trim());
  const out = new Set<string>();
  if (!q) return out;
  for (const n of nodes) if (fold(n.title).includes(q)) out.add(n.id);
  return out;
}

export interface GraphColors {
  bg: string;
  edge: string;
  edgeHighlight: string;
  text: string;
  textMuted: string;
  labelBg: string;
  page: string;
  concept: string;
  daily: string;
  match: string;
  font: string;
}

/** Resolves the theme's CSS variables into canvas colours. */
export function readGraphColors(el: Element): GraphColors {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg', 'Canvas'),
    edge: v('--border-strong', 'GrayText'),
    edgeHighlight: v('--accent', 'Highlight'),
    text: v('--text', 'CanvasText'),
    textMuted: v('--text-muted', 'GrayText'),
    labelBg: v('--bg-elev', 'Canvas'),
    page: v('--accent', 'Highlight'),
    concept: v('--tag', 'LinkText'),
    daily: v('--gold', 'Mark'),
    match: v('--gold', 'Mark'),
    font: v('--font-ui', 'sans-serif'),
  };
}

export function colorForKind(kind: GraphNodeKind, c: GraphColors): string {
  return kind === 'daily' ? c.daily : kind === 'concept' ? c.concept : c.page;
}
