import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Vault } from '../../core/vault';
import { insertBlock } from '../../core/blocks';
import { syncCards } from '../../core/srs/cards';
import { readLog } from '../../core/srs/queue';
import { DAY, newCardState } from '../../core/srs/fsrs';
import { ReviewView, formatWhen } from './ReviewView';
import { AIBridgeDialog } from './AIBridgeDialog';
import { BridgeProvider } from '../../core/ai/bridge';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let n = 0;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const vault = await Vault.open(`test-review-ui-${Date.now()}-${n++}`);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  cleanup.push(async () => {
    act(() => root.unmount());
    container.remove();
    await vault.close();
  });
  return { vault, container, root };
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ReviewView', () => {
  it('shows an empty state without cards', async () => {
    const { vault, container, root } = await setup();
    await act(async () => {
      root.render(<ReviewView vault={vault} renderBlock={() => null} onOpenAnchor={() => {}} onOpenPage={() => {}} />);
    });
    expect(container.textContent).toContain('No flashcards yet');
  });

  it('reviews a cloze card with the keyboard, then undoes', async () => {
    const { vault, container, root } = await setup();
    const pageId = vault.createPage({ title: 'Thermo' });
    await syncCards(vault, [{ pageId, blockId: 'b1', type: 'text', text: 'Heat flows to {{c1::colder}} bodies #flashcard', pageTitle: 'Thermo' }]);
    await act(async () => {
      root.render(<ReviewView vault={vault} renderBlock={() => null} onOpenAnchor={() => {}} onOpenPage={() => {}} />);
    });
    expect(container.querySelector('.rv-card')?.textContent).toContain('[...]');
    expect(container.textContent).toContain('Thermo');
    expect(container.querySelector('.rv-count-new')?.textContent).toContain('1');

    press(' ');
    expect(container.querySelector('.cloze-revealed')?.textContent).toBe('colder');
    const labels = [...container.querySelectorAll('.rv-rate-ivl')].map((e) => e.textContent);
    expect(labels).toEqual(['1m', '6m', '10m', expect.stringMatching(/d$/)]);

    press('4'); // Easy → graduates, queue empties
    expect(vault.cards.get('b1:1')!.state).toBe('review');
    expect(readLog(vault)).toHaveLength(1);
    expect(container.textContent).toContain('All caught up');
    expect(container.querySelectorAll('.rv-forecast-col')).toHaveLength(7);

    press('z', { ctrlKey: true });
    expect(vault.cards.get('b1:1')!.state).toBe('new');
    expect(readLog(vault)).toHaveLength(0);
    expect(container.querySelector('.rv-card')).not.toBeNull();
  });

  it('renders basic cards with the block as the answer', async () => {
    const { vault, container, root } = await setup();
    await syncCards(vault, [{ pageId: 'p', blockId: 'm1', type: 'math', text: 'e^{i\\pi}+1=0', pageTitle: 'Euler' }]);
    const renderBlock = vi.fn((_p: string, b: string) => <div className="block-probe">{b}</div>);
    await act(async () => {
      root.render(<ReviewView vault={vault} renderBlock={renderBlock} onOpenAnchor={() => {}} onOpenPage={() => {}} />);
    });
    expect(container.querySelector('.rv-card')?.textContent).toContain('Recall:');
    await act(async () => {
      (container.querySelector('.rv-show') as HTMLButtonElement).click();
    });
    expect(container.querySelector('.block-probe')?.textContent).toBe('m1');
    expect(renderBlock).toHaveBeenCalledWith('p', 'm1');
  });

  it('shows the leech callout with the block anchor', async () => {
    const { vault, container, root } = await setup();
    const pageId = vault.createPage({ title: 'Notes' });
    const { doc, release } = await vault.openPage(pageId);
    const anchor = { sourceId: 's1', loc: { page: 12 }, quote: 'The original sentence', createdAt: 1 };
    const blockId = insertBlock(doc, { type: 'text', text: 'X {{c1::y}}', anchor });
    release();
    const now = Date.now();
    vault.transact(() =>
      vault.cards.set(`${blockId}:1`, {
        id: `${blockId}:1`, pageId, blockId, kind: 'cloze', front: 'X {{c1::y}}', clozeIndex: 1, srcHash: 'h', createdAt: now,
        ...newCardState(now), state: 'review', due: now - DAY, stability: 2, difficulty: 8, reps: 9, lapses: 5, lastReview: now - 3 * DAY, leech: true,
      }),
    );
    const onOpenAnchor = vi.fn();
    await act(async () => {
      root.render(<ReviewView vault={vault} renderBlock={() => null} onOpenAnchor={onOpenAnchor} onOpenPage={() => {}} />);
    });
    await act(async () => {
      await wait(30);
    });
    expect(container.textContent).toContain('This card keeps slipping');
    expect(container.textContent).toContain('The original sentence');
    await act(async () => {
      (container.querySelector('.rv-leech .rv-btn-primary') as HTMLButtonElement).click();
    });
    expect(onOpenAnchor).toHaveBeenCalledWith(anchor);
  });
});

describe('AIBridgeDialog', () => {
  it('resolves the bridge provider with the pasted answer', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    await act(async () => root.render(<AIBridgeDialog />));
    expect(container.innerHTML).toBe('');

    const provider = new BridgeProvider(() => ({ enabled: true, target: 'chatgpt' }));
    let result: Promise<string>;
    await act(async () => {
      result = provider.complete({ task: 'summarize', prompt: 'Summarize X' });
    });
    expect(container.textContent).toContain('Summarize');
    expect(container.textContent).toContain('ChatGPT');

    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'The pasted summary');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('.rv-bridge-foot .rv-bridge-primary') as HTMLButtonElement).click();
    });
    await expect(result!).resolves.toBe('The pasted summary');
    expect(container.innerHTML).toBe('');
  });
});

describe('formatWhen', () => {
  it('formats relative times', () => {
    const now = new Date(2026, 0, 5, 10, 0).getTime();
    expect(formatWhen(now + 30_000, now)).toBe('now');
    expect(formatWhen(now + 12 * 60_000, now)).toBe('in 12 min');
    expect(formatWhen(now + 3 * 3600_000, now)).toBe('in 3 h');
    expect(formatWhen(now + DAY, now)).toMatch(/^tomorrow, /);
  });
});
