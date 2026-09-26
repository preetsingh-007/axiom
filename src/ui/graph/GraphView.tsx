import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { Maximize2, Search } from 'lucide-react';
import type { GraphIndex, GraphNode } from '../../core/graph/index';
import { colorForKind, labelMinWeight, localSubgraph, matchNodes, nodeRadius, readGraphColors, type GraphColors } from './model';
import './graph.css';

export interface GraphViewProps {
  index: GraphIndex;
  onOpenPage(pageId: string): void;
  /** local-graph mode: show the 2-hop neighbourhood of this page */
  focusPageId?: string;
  /** called for concept nodes that have no page yet (e.g. `t => onOpenPage(vault.ensureConcept(t))`) */
  onOpenConcept?(title: string): void;
}

type SimNode = GraphNode & SimulationNodeDatum & { r: number };
type SimLink = SimulationLinkDatum<SimNode> & { weight: number };

interface View {
  x: number;
  y: number;
  k: number;
}

interface Tooltip {
  x: number;
  y: number;
  node: SimNode;
  degree: number;
}

const MIN_K = 0.04;
const MAX_K = 8;
const CLICK_SLOP = 4;
const TICK_BUDGET_MS = 8;

/**
 * Force-directed knowledge graph rendered on a canvas (d3-force layout).
 * Pan by dragging the background (or two fingers), zoom with the wheel or pinch, drag nodes,
 * hover to highlight neighbours, click to open.
 */
export function GraphView({ index, onOpenPage, focusPageId, onOpenConcept }: GraphViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [empty, setEmpty] = useState(false);

  // Mutable rendering state lives in a ref: React only renders the chrome around the canvas.
  const st = useRef({
    nodes: [] as SimNode[],
    links: [] as SimLink[],
    byId: new Map<string, SimNode>(),
    adj: new Map<string, Set<string>>(),
    weightsDesc: [] as number[],
    sim: null as Simulation<SimNode, SimLink> | null,
    view: { x: 0, y: 0, k: 1 } as View,
    size: { w: 0, h: 0, dpr: 1 },
    colors: null as GraphColors | null,
    hover: null as SimNode | null,
    matches: new Set<string>(),
    raf: 0,
    dragging: false,
    fitted: false,
  });
  const callbacks = useRef({ onOpenPage, onOpenConcept });
  callbacks.current = { onOpenPage, onOpenConcept };
  const queryRef = useRef(query);
  queryRef.current = query;

  // ------------------------------------------------------------------ drawing (stable engine)

  const engine = useMemo(() => {
    const draw = () => {
      const s = st.current;
      const canvas = canvasRef.current;
      if (!canvas || !s.colors) return;
      let ctx: CanvasRenderingContext2D | null = null;
      try {
        ctx = canvas.getContext('2d');
      } catch {
        ctx = null;
      }
      if (!ctx) return;
      const { w, h, dpr } = s.size;
      const { x: tx, y: ty, k } = s.view;
      const c = s.colors;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = c.bg;
      ctx.fillRect(0, 0, w, h);
      const cx = w / 2 + tx;
      const cy = h / 2 + ty;
      const toSx = (x: number) => x * k + cx;
      const toSy = (y: number) => y * k + cy;
      // visible world rect (with margin)
      const margin = 40 / k;
      const x0 = -cx / k - margin;
      const x1 = (w - cx) / k + margin;
      const y0 = -cy / k - margin;
      const y1 = (h - cy) / k + margin;
      const visible = (n: SimNode) => n.x! >= x0 && n.x! <= x1 && n.y! >= y0 && n.y! <= y1;

      const focus = s.hover;
      const focusSet = focus ? s.adj.get(focus.id) : undefined;
      const searching = s.matches.size > 0;
      const isLit = (n: SimNode) => (focus ? n === focus || !!focusSet?.has(n.id) : searching ? s.matches.has(n.id) : true);

      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * cx, dpr * cy);
      // edges: one batched path for the dim ones, one for the highlighted ones
      ctx.lineWidth = Math.max(0.5 / k, 0.6);
      ctx.strokeStyle = c.edge;
      ctx.globalAlpha = focus || searching ? 0.25 : 0.6;
      ctx.beginPath();
      const hi: SimLink[] = [];
      for (const l of s.links) {
        const a = l.source as SimNode;
        const b = l.target as SimNode;
        if (!visible(a) && !visible(b)) continue;
        if (focus && (a === focus || b === focus)) {
          hi.push(l);
          continue;
        }
        ctx.moveTo(a.x!, a.y!);
        ctx.lineTo(b.x!, b.y!);
      }
      ctx.stroke();
      if (hi.length) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = c.edgeHighlight;
        ctx.lineWidth = Math.max(1.2 / k, 1);
        ctx.beginPath();
        for (const l of hi) {
          const a = l.source as SimNode;
          const b = l.target as SimNode;
          ctx.moveTo(a.x!, a.y!);
          ctx.lineTo(b.x!, b.y!);
        }
        ctx.stroke();
      }

      // nodes, batched by colour and lit state
      for (const lit of [false, true]) {
        ctx.globalAlpha = lit ? 1 : 0.18;
        for (const kind of ['page', 'concept', 'daily'] as const) {
          ctx.fillStyle = colorForKind(kind, c);
          ctx.beginPath();
          for (const n of s.nodes) {
            if (n.kind !== kind || isLit(n) !== lit || !visible(n)) continue;
            ctx.moveTo(n.x! + n.r, n.y!);
            ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
          }
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if (searching) {
        ctx.strokeStyle = c.match;
        ctx.lineWidth = 2 / k;
        ctx.beginPath();
        for (const id of s.matches) {
          const n = s.byId.get(id);
          if (!n || !visible(n)) continue;
          ctx.moveTo(n.x! + n.r + 3 / k, n.y!);
          ctx.arc(n.x!, n.y!, n.r + 3 / k, 0, Math.PI * 2);
        }
        ctx.stroke();
      }

      // labels in screen space (crisp text)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const minW = labelMinWeight(s.weightsDesc, k);
      ctx.font = `12px ${c.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const n of s.nodes) {
        const forced = n === focus || (focus ? focusSet?.has(n.id) : false) || (searching && s.matches.has(n.id));
        if (!forced && (n.weight < minW || focus || searching)) continue;
        if (!visible(n)) continue;
        const sx = toSx(n.x!);
        const sy = toSy(n.y!) + n.r * k + 3;
        const label = n.title.length > 40 ? n.title.slice(0, 39) + '…' : n.title;
        ctx.globalAlpha = forced ? 1 : 0.85;
        ctx.fillStyle = forced ? c.text : c.textMuted;
        ctx.fillText(label, sx, sy);
      }
      ctx.globalAlpha = 1;
    };

    const frame = () => {
      const s = st.current;
      s.raf = 0;
      const sim = s.sim;
      let running = false;
      if (sim && (sim.alpha() > sim.alphaMin() || s.dragging)) {
        const start = performance.now();
        let ticks = 0;
        do {
          sim.tick();
          ticks++;
        } while (ticks < 3 && performance.now() - start < TICK_BUDGET_MS);
        running = true;
        if (!s.fitted && sim.alpha() < 0.3) {
          s.fitted = true;
          fitView();
        }
      }
      draw();
      if (running) s.raf = requestAnimationFrame(frame);
    };

    const requestDraw = () => {
      const s = st.current;
      if (!s.raf) s.raf = requestAnimationFrame(frame);
    };

    const fitView = () => {
      const s = st.current;
      const { w, h } = s.size;
      if (!s.nodes.length || !w || !h) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of s.nodes) {
        minX = Math.min(minX, n.x! - n.r);
        maxX = Math.max(maxX, n.x! + n.r);
        minY = Math.min(minY, n.y! - n.r);
        maxY = Math.max(maxY, n.y! + n.r);
      }
      const k = clamp(Math.min(w / (maxX - minX + 80), h / (maxY - minY + 80)), MIN_K, 2);
      s.view = { k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k };
      requestDraw();
    };

    return { requestDraw, fitView };
  }, []);
  const { requestDraw, fitView } = engine;

  // ------------------------------------------------------------------ data

  useEffect(() => {
    const s = st.current;
    let signature = '';
    const load = () => {
      const full = index.graph();
      const data = focusPageId ? localSubgraph(full, focusPageId) : full;
      // plain-text edits invalidate the index but not the graph: keep the layout still
      const sig =
        data.nodes.map((n) => n.id + '\u0001' + n.title + '\u0001' + n.weight).join('\u0002') +
        '\u0003' +
        data.links.map((l) => l.source + '\u0001' + l.target + '\u0001' + l.weight).join('\u0002');
      if (sig === signature) return;
      signature = sig;
      const prev = s.byId;
      const nodes: SimNode[] = data.nodes.map((n) => {
        const old = prev.get(n.id);
        const node: SimNode = { ...n, r: nodeRadius(n.weight) };
        if (old) {
          node.x = old.x;
          node.y = old.y;
          node.vx = old.vx;
          node.vy = old.vy;
        }
        if (n.id === focusPageId) {
          node.fx = 0;
          node.fy = 0;
        }
        return node;
      });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const links: SimLink[] = data.links
        .filter((l) => byId.has(l.source) && byId.has(l.target))
        .map((l) => ({ source: l.source, target: l.target, weight: l.weight }));
      const adj = new Map<string, Set<string>>();
      for (const l of data.links) {
        (adj.get(l.source) ?? adj.set(l.source, new Set()).get(l.source)!).add(l.target);
        (adj.get(l.target) ?? adj.set(l.target, new Set()).get(l.target)!).add(l.source);
      }
      const reused = nodes.some((n) => prev.has(n.id));
      s.nodes = nodes;
      s.links = links;
      s.byId = byId;
      s.adj = adj;
      s.weightsDesc = nodes.map((n) => n.weight).sort((a, b) => b - a);
      s.matches = matchNodes(nodes, queryRef.current);
      setMatchCount(s.matches.size);
      setEmpty(nodes.length === 0);
      if (s.hover && !byId.has(s.hover.id)) s.hover = null;

      const big = nodes.length > 1500;
      s.sim?.stop();
      s.sim = forceSimulation<SimNode, SimLink>(nodes)
        .force(
          'charge',
          forceManyBody<SimNode>()
            .strength(big ? -18 : -40)
            .theta(0.9)
            .distanceMax(big ? 300 : 600),
        )
        .force(
          'link',
          forceLink<SimNode, SimLink>(links)
            .id((d) => d.id)
            .distance((l) => 30 + ((l.source as SimNode).r + (l.target as SimNode).r)),
        )
        .force('center', forceCenter(0, 0))
        .force('x', forceX(0).strength(0.04))
        .force('y', forceY(0).strength(0.04))
        .force('collide', forceCollide<SimNode>((d) => d.r + 2).iterations(1))
        .alphaDecay(big ? 0.05 : 0.03)
        .alphaMin(0.005)
        .alpha(reused ? 0.3 : 1)
        .stop();
      if (!reused) s.fitted = false;
      requestDraw();
    };
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = index.onChange.on(() => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    });
    return () => {
      off();
      clearTimeout(timer);
      s.sim?.stop();
    };
  }, [index, focusPageId, requestDraw]);

  // search highlighting
  useEffect(() => {
    const s = st.current;
    s.matches = matchNodes(s.nodes, query);
    setMatchCount(s.matches.size);
    requestDraw();
  }, [query, requestDraw]);

  // ------------------------------------------------------------------ canvas size + theme

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const s = st.current;
    const resize = () => {
      const rect = root.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      s.size = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      requestDraw();
    };
    const recolor = () => {
      s.colors = readGraphColors(root);
      requestDraw();
    };
    recolor();
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(root);
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery?.addEventListener?.('change', resize);
    return () => {
      ro?.disconnect();
      mo.disconnect();
      dprQuery?.removeEventListener?.('change', resize);
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
  }, [requestDraw]);

  // ------------------------------------------------------------------ interaction

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = st.current;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { node: SimNode | null; startX: number; startY: number; moved: boolean } | null = null;
    let pinch: { dist: number; mx: number; my: number } | null = null;

    const local = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const toWorld = (sx: number, sy: number) => {
      const { w, h } = s.size;
      const { x, y, k } = s.view;
      return { x: (sx - w / 2 - x) / k, y: (sy - h / 2 - y) / k };
    };
    const nodeAt = (sx: number, sy: number): SimNode | null => {
      if (!s.sim) return null;
      const p = toWorld(sx, sy);
      const n = s.sim.find(p.x, p.y, 30 / s.view.k + 22);
      if (!n) return null;
      const d = Math.hypot(n.x! - p.x, n.y! - p.y);
      return d <= n.r + 5 / s.view.k ? n : null;
    };
    const zoomAt = (sx: number, sy: number, factor: number) => {
      const { w, h } = s.size;
      const v = s.view;
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const wx = (sx - w / 2 - v.x) / v.k;
      const wy = (sy - h / 2 - v.y) / v.k;
      s.view = { k, x: sx - w / 2 - wx * k, y: sy - h / 2 - wy * k };
      requestDraw();
    };
    const setHover = (n: SimNode | null, sx: number, sy: number) => {
      if (s.hover !== n) {
        s.hover = n;
        requestDraw();
      }
      canvas.style.cursor = n ? 'pointer' : drag ? 'grabbing' : 'grab';
      setTooltip(n ? { x: sx, y: sy, node: n, degree: s.adj.get(n.id)?.size ?? 0 } : null);
    };

    const releaseNode = (node: SimNode) => {
      if (node.id !== focusPageId) {
        node.fx = null;
        node.fy = null;
      }
      s.dragging = false;
      s.sim?.alphaTarget(0);
    };
    const onDown = (e: PointerEvent) => {
      const p = local(e);
      pointers.set(e.pointerId, p);
      canvas.setPointerCapture?.(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        if (drag?.node) releaseNode(drag.node);
        drag = null;
        return;
      }
      const node = nodeAt(p.x, p.y);
      drag = { node, startX: p.x, startY: p.y, moved: false };
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
        s.dragging = true;
        s.sim?.alphaTarget(0.25);
        requestDraw();
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      const prev = pointers.get(e.pointerId);
      if (prev) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        s.view = { ...s.view, x: s.view.x + (mx - pinch.mx), y: s.view.y + (my - pinch.my) };
        if (pinch.dist > 0) zoomAt(mx, my, dist / pinch.dist);
        pinch = { dist, mx, my };
        requestDraw();
        return;
      }
      if (!drag || !prev) {
        setHover(nodeAt(p.x, p.y), p.x, p.y);
        return;
      }
      if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) > CLICK_SLOP) drag.moved = true;
      if (!drag.moved) return;
      if (drag.node) {
        const w = toWorld(p.x, p.y);
        drag.node.fx = w.x;
        drag.node.fy = w.y;
        setTooltip(null);
      } else {
        s.view = { ...s.view, x: s.view.x + (p.x - prev.x), y: s.view.y + (p.y - prev.y) };
        canvas.style.cursor = 'grabbing';
      }
      requestDraw();
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        return;
      }
      const d = drag;
      drag = null;
      if (!d) return;
      if (d.node) releaseNode(d.node);
      if (!d.moved && e.type === 'pointerup') {
        const n = d.node;
        if (n?.pageId) callbacks.current.onOpenPage(n.pageId);
        else if (n) callbacks.current.onOpenConcept?.(n.title);
      }
      canvas.style.cursor = 'grab';
      requestDraw();
    };
    const onLeave = () => {
      if (!drag) setHover(null, 0, 0);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [focusPageId, requestDraw]);

  const centerOnBestMatch = () => {
    const s = st.current;
    let best: SimNode | null = null;
    for (const id of s.matches) {
      const n = s.byId.get(id);
      if (n && (!best || n.weight > best.weight)) best = n;
    }
    if (!best) return;
    const k = Math.max(s.view.k, 1.5);
    s.view = { k, x: -best.x! * k, y: -best.y! * k };
    requestDraw();
  };

  return (
    <div className="gv-root" ref={rootRef}>
      <canvas ref={canvasRef} className="gv-canvas" role="img" aria-label={focusPageId ? 'Local graph' : 'Knowledge graph'} />
      <div className="gv-toolbar">
        <label className="gv-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="Highlight nodes…"
            aria-label="Highlight nodes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') centerOnBestMatch();
              if (e.key === 'Escape') setQuery('');
            }}
          />
          {query.trim() && <span className="gv-count">{matchCount}</span>}
        </label>
        <button type="button" className="gv-btn" title="Fit to view" aria-label="Fit to view" onClick={fitView}>
          <Maximize2 size={14} />
        </button>
      </div>
      <div className="gv-legend" aria-hidden="true">
        <span className="gv-dot gv-dot-page" />
        Page
        <span className="gv-dot gv-dot-concept" />
        Concept
        <span className="gv-dot gv-dot-daily" />
        Daily
      </div>
      {empty && <div className="gv-empty">Nothing linked yet — write [[links]] or #tags to grow the graph.</div>}
      {tooltip && (
        <div className="gv-tooltip" style={{ transform: `translate(${tooltip.x + 14}px, ${tooltip.y + 14}px)` }}>
          <div className="gv-tooltip-title">{tooltip.node.title}</div>
          <div className="gv-tooltip-meta">
            {tooltip.node.kind} · {tooltip.degree} {tooltip.degree === 1 ? 'connection' : 'connections'}
          </div>
        </div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
