import { getServicesUnsafe } from './servicesRef';
import { useUI } from './store';
import { insertBlocks, type NewBlock } from '../../core/blocks';
import { isoDate } from '../../core/util/ids';
import type { AppServices } from './bootstrap';
import { renamePage, resolveConceptAlias } from '../../core/graph/merge';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function services(): AppServices {
  return getServicesUnsafe() as AppServices;
}

/** Resolves a [[link]] / #tag target to a page id, creating it when needed. */
export function resolvePage(title: string): string {
  const { vault } = services();
  const t = title.trim();
  if (DATE_RE.test(t)) return vault.ensureDaily(t);
  return vault.ensureConcept(resolveConceptAlias(vault, t));
}

export function openPageByTitle(title: string, opts: { sideQuest?: boolean } = {}) {
  const id = resolvePage(title);
  if (opts.sideQuest) useUI.getState().openSideQuest(id);
  else useUI.getState().navigate({ name: 'page', pageId: id });
}

export function createNote(title = 'Untitled') {
  const { vault } = services();
  const id = vault.createPage({ title, kind: 'note' });
  useUI.getState().navigate({ name: 'page', pageId: id });
  // select the title for immediate renaming
  setTimeout(() => {
    const h = document.querySelector<HTMLElement>(`[data-page-id="${id}"] .page-title.editable`);
    if (!h) return;
    h.focus();
    const range = document.createRange();
    range.selectNodeContents(h);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, 60);
  return id;
}

export async function renamePageEverywhere(pageId: string, title: string) {
  const { vault, graph } = services();
  try {
    await renamePage(vault, graph, pageId, title);
  } catch (e) {
    console.error(e);
    vault.updatePage(pageId, { title });
  }
}

/** The page the user is currently writing in (route page, else today's daily). */
export function currentDeskPageId(): string {
  const { vault } = services();
  const r = useUI.getState().route;
  if (r.name === 'page') return r.pageId;
  return vault.ensureDaily(isoDate());
}

/** Appends blocks to the current desk page (Lasso & Drop's "Send to Desk"). */
export async function sendToDesk(blocks: NewBlock[], opts: { pageId?: string; quiet?: boolean } = {}) {
  const { vault } = services();
  const pageId = opts.pageId ?? currentDeskPageId();
  const { doc, release } = await vault.openPage(pageId);
  try {
    // drop a trailing empty text block so extractions don't pile up after a blank line
    insertBlocks(doc, blocks);
  } finally {
    setTimeout(release, 1000);
  }
  if (!opts.quiet) {
    const title = vault.getPage(pageId)?.title ?? 'Desk';
    const r = useUI.getState().route;
    const visible = (r.name === 'page' && r.pageId === pageId) || (r.name === 'stream' && pageId === vault.ensureDaily(isoDate()));
    useUI.getState().toast({
      message: `Added to ${vault.getPage(pageId)?.kind === 'daily' ? 'today' : `“${title}”`}`,
      kind: 'success',
      action: visible ? undefined : { label: 'Open', run: () => useUI.getState().navigate({ name: 'page', pageId }) },
    });
  }
  return pageId;
}

export function openToday() {
  useUI.getState().navigate({ name: 'stream' });
}
