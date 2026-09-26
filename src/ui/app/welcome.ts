import type { Vault } from '../../core/vault';
import { insertBlocks, type NewBlock } from '../../core/blocks';

const WELCOME_ID = 'p-welcome';

/** Seeds a short guided tour the first time a vault is opened. */
export async function seedWelcome(vault: Vault) {
  if (vault.settings.get('seeded') || vault.pages.size > 0) return;
  vault.transact(() => vault.settings.set('seeded', Date.now()));
  vault.createPage({ id: WELCOME_ID, title: 'Welcome to Axiom', kind: 'note' });
  const { doc, release } = await vault.openPage(WELCOME_ID);
  const blocks: NewBlock[] = [
    { type: 'text', text: 'Axiom is a **local-first** research notebook. Everything lives on this device, syncs between your devices in real time, and backs up to your own Git repository — no subscription, no server bill.' },
    { type: 'text', text: '## The Desk and the Library\nThe **Library** holds pristine PDFs, EPUBs and slide decks. The **Desk** is where you think. Open a paper, then **lasso** (stylus, Alt+drag, or the lasso tool) any paragraph, equation or figure and drop it here — it arrives as editable Markdown, LaTeX or an image, tethered to its source by a *Wormhole anchor* ⚓.' },
    { type: 'text', text: '## Writing\n- Link ideas with [[Reinforcement Learning]] — links create concept pages and backlinks.\n- Inline math like $\\mathbb{E}_{\\pi}[G_t]$ or a display block via `/math`.\n- Transclude a page inline with `![[Page]]`.\n- Type `/` for commands; `Cmd/Ctrl+K` to search anything.' },
    { type: 'math', text: 'V^{\\pi}(s) = \\mathbb{E}_{\\pi}\\Big[\\sum_{t=0}^{\\infty} \\gamma^t r_{t+1} \\,\\Big|\\, s_0 = s\\Big]' },
    { type: 'text', text: '## Whiteboard space\nSpread two fingers vertically between paragraphs (or pinch on a trackpad with Ctrl) to open whiteboard space; pinch to snap it shut. Lasso messy ink and **double-tap** to Beautify it into text, LaTeX and clean shapes — always reversible.' },
    { type: 'ink', height: 260 },
    { type: 'text', text: '## Remember what matters\nThe **Bellman equation** expresses a value function recursively in terms of successor values. #flashcard' },
    { type: 'text', text: 'Tag any block with `#flashcard` and it joins your review queue with auto-generated cloze cards, scheduled by FSRS.' },
  ];
  insertBlocks(doc, blocks);
  release();
}
