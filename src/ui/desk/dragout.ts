import type { BlockSnapshot } from '../../core/blocks';
import { blockToLatex, blockToMarkdown, type ExportContext } from '../../core/export/markdown';
import { renderMarkdown, renderMath } from '../markdown/render';
import { getServicesUnsafe } from '../app/servicesRef';
import { inkSvgForExport } from './blocks/InkBlock';

/** Internal drag type: moving/copying blocks between pages. */
export const BLOCK_MIME = 'application/x-axiom-block';
/** Internal drag type: extraction dragged out of the Library. */
export const EXTRACT_MIME = 'application/x-axiom-extract';

function exportCtx(): ExportContext {
  let vault: ReturnType<typeof getServicesUnsafe>['vault'] | undefined;
  try {
    vault = getServicesUnsafe().vault;
  } catch {
    vault = undefined;
  }
  return {
    source: (id) => vault?.getSource(id),
    inkToSvg: (b) => inkSvgForExport(b),
  };
}

export function exportBlock(b: BlockSnapshot, fmt: 'md' | 'tex'): string {
  return fmt === 'md' ? blockToMarkdown(b, exportCtx()) : blockToLatex(b, exportCtx());
}

/**
 * Data offered when a block is dragged: other apps (Overleaf, VS Code, Markdown editors) pick
 * text/plain (Markdown, or LaTeX for equations), rich editors pick text/html, and Axiom itself
 * reads the internal mime to move/copy the block.
 */
export function blockDragPayload(pageId: string, b: BlockSnapshot): Record<string, string> {
  const ctx = exportCtx();
  const out: Record<string, string> = {};
  out[BLOCK_MIME] = JSON.stringify({ pageId, block: b });
  if (b.type === 'math') {
    out['text/plain'] = `$$\n${b.text.trim()}\n$$`;
    out['text/html'] = renderMath(b.text, true);
    out['text/x-latex'] = b.text;
  } else if (b.type === 'ink') {
    const svg = inkSvgForExport(b);
    const md = blockToMarkdown(b, ctx);
    out['text/plain'] = md || svg;
    if (svg) {
      out['image/svg+xml'] = svg;
      out['text/html'] = svg;
    }
  } else {
    const md = blockToMarkdown(b, ctx);
    out['text/plain'] = md;
    out['text/markdown'] = md;
    if (b.type === 'text') out['text/html'] = renderMarkdown(md);
    out['text/x-latex'] = blockToLatex(b, ctx);
  }
  return out;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}
