import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { GraphData } from '../../core/graph/index';
import { GraphIndex } from '../../core/graph/index';
import { addPage, openTestVault } from '../../core/graph/testutil';
import { blockIds, blockPlainText, blocksOf } from '../../core/blocks';
import { BacklinksPanel } from './BacklinksPanel';
import { GraphView } from './GraphView';
import { labelMinWeight, localSubgraph, matchNodes, nodeRadius, readGraphColors } from './model';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('graph model', () => {
  const data: GraphData = {
    nodes: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, title: id === 'c' ? 'Théorie' : id.toUpperCase(), kind: 'page' as const, weight: i + 1 })),
    links: [
      { source: 'a', target: 'b', weight: 1 },
      { source: 'c', target: 'b', weight: 2 },
      { source: 'c', target: 'd', weight: 1 },
      { source: 'd', target: 'e', weight: 1 },
    ],
  };

  it('extracts a 2-hop neighbourhood', () => {
    const sub = localSubgraph(data, 'a');
    expect(sub.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(sub.links).toHaveLength(2);
    expect(localSubgraph(data, 'a', 1).nodes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('sizes nodes and shows more labels when zoomed in', () => {
    expect(nodeRadius(1)).toBe(3);
    expect(nodeRadius(1e6)).toBe(22);
    const weights = Array.from({ length: 1000 }, (_, i) => 1000 - i);
    expect(labelMinWeight(weights, 1)).toBe(970);
    expect(labelMinWeight(weights, 4)).toBeLessThan(labelMinWeight(weights, 1));
    expect(labelMinWeight([], 1)).toBe(Infinity);
  });

  it('matches node titles ignoring case and diacritics', () => {
    expect([...matchNodes(data.nodes, 'theo')]).toEqual(['c']);
    expect(matchNodes(data.nodes, '  ').size).toBe(0);
  });

  it('reads theme colours from CSS variables', () => {
    const el = document.createElement('div');
    el.style.setProperty('--accent', 'rgb(1, 2, 3)');
    el.style.setProperty('--tag', 'rgb(4, 5, 6)');
    document.body.appendChild(el);
    const c = readGraphColors(el);
    expect(c.page).toBe('rgb(1, 2, 3)');
    expect(c.concept).toBe('rgb(4, 5, 6)');
    el.remove();
  });
});

async function setupVault() {
  const vault = await openTestVault();
  const index = new GraphIndex(vault, { debounceMs: 5, changeDebounceMs: 5, persist: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    act(() => root.unmount());
    container.remove();
    await index.destroy();
    await vault.close();
  });
  return { vault, index, container, root };
}

describe('GraphView', () => {
  it('renders the canvas, highlights search matches and follows index changes', async () => {
    const { vault, index, container, root } = await setupVault();
    await addPage(vault, 'Alpha', ['links [[Beta]] #topic']);
    await index.init();
    const onOpen = vi.fn();
    await act(async () => root.render(<GraphView index={index} onOpenPage={onOpen} />));
    expect(container.querySelector('canvas.gv-canvas')).not.toBeNull();
    const input = container.querySelector('input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'bet');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('.gv-count')?.textContent).toBe('1');
    expect(container.querySelector('.gv-empty')).toBeNull();

    await act(async () => root.render(<GraphView index={index} onOpenPage={onOpen} focusPageId="missing" />));
    expect(container.querySelector('.gv-empty')).not.toBeNull();
  });
});

describe('BacklinksPanel', () => {
  it('lists linked references and links unlinked mentions', async () => {
    const { vault, index, container, root } = await setupVault();
    const target = await addPage(vault, 'Policy Gradient', ['def'], { kind: 'concept' });
    const src = await addPage(vault, 'Notes', ['uses [[Policy Gradient]]', 'policy gradient methods']);
    await index.init();
    const onOpen = vi.fn();
    await act(async () => root.render(<BacklinksPanel index={index} vault={vault} pageId={target} onOpenPage={onOpen} />));

    const groups = container.querySelectorAll('.gv-bl-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].querySelector('.gv-bl-page')!.textContent).toBe('Notes');
    expect(container.querySelector('.gv-bl-snippet')!.textContent).toBe('uses Policy Gradient');
    await act(async () => (container.querySelector('.gv-bl-snippet') as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith(src, expect.any(String));

    await act(async () => (container.querySelector('.gv-bl-toggle') as HTMLButtonElement).click());
    const linkBtn = container.querySelector('.gv-bl-link') as HTMLButtonElement;
    expect(linkBtn).not.toBeNull();
    await act(async () => {
      linkBtn.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      await index.flush();
    });
    const { doc, release } = await vault.openPage(src);
    expect(blockIds(doc).map((id) => blockPlainText(blocksOf(doc).get(id)!))).toEqual(['uses [[Policy Gradient]]', '[[policy gradient]] methods']);
    release();
    expect(container.querySelectorAll('.gv-bl-group')[0].querySelectorAll('.gv-bl-item')).toHaveLength(2);
    expect(container.querySelector('.gv-bl-link')).toBeNull();
  });
});
