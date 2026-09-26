import type { BlockSnapshot } from '../blocks';
import type { Beautified, SourceMeta } from '../schema';

/**
 * Export / publication: converts blocks to Markdown and LaTeX so they can be dragged into
 * Overleaf, VS Code or any Markdown editor.
 */

export interface ExportContext {
  /** resolve a source for citations (\cite{bibKey}) */
  source?: (id: string) => SourceMeta | undefined;
  /** render an ink block to standalone SVG */
  inkToSvg?: (b: BlockSnapshot) => string;
  /** URL / path for an image blob */
  imageUrl?: (blobId: string) => string;
}

/** Removes Axiom-only syntax that means nothing outside the app. */
export function cleanMarkdown(text: string): string {
  return text
    .replace(/\s*#flashcard\b/gi, '')
    .replace(/\{\{c\d+::([\s\S]+?)(?:::[^}]*)?\}\}/g, '$1')
    .replace(/#\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!\[\[([^\]|#]+)(?:#\^[^\]|]+)?(?:\|[^\]]+)?\]\]/g, '*(see: $1)*')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\(\([A-Za-z0-9_-]{6,}\)\)/g, '')
    .trimEnd();
}

function beautifiedToMarkdown(b: Beautified): string {
  const parts: string[] = [];
  const items = [...b.items].sort((x, y) => {
    const ay = 'y' in x ? x.y : x.bbox[1];
    const by = 'y' in y ? y.y : y.bbox[1];
    return ay - by;
  });
  for (const it of items) {
    if (it.kind === 'text') parts.push(it.text);
    else if (it.kind === 'latex') parts.push(`$$\n${it.latex}\n$$`);
  }
  return parts.join('\n\n');
}

function citation(b: BlockSnapshot, ctx: ExportContext): string {
  if (!b.anchor || !ctx.source) return '';
  const src = ctx.source(b.anchor.sourceId);
  if (!src) return '';
  const key = src.bib?.bibKey;
  const page = b.anchor.loc.page ? `, p. ${b.anchor.loc.page}` : '';
  return key ? ` [@${key}${page}]` : ` (${src.title}${page})`;
}

export function blockToMarkdown(b: BlockSnapshot, ctx: ExportContext = {}): string {
  switch (b.type) {
    case 'text':
      return cleanMarkdown(b.text) + citation(b, ctx);
    case 'math':
      return `$$\n${b.text.trim()}\n$$`;
    case 'code':
      return '```' + (b.lang ?? '') + '\n' + b.text + '\n```';
    case 'image':
    case 'slide': {
      const alt = b.image?.alt ?? b.text ?? 'figure';
      const url = b.image && ctx.imageUrl ? ctx.imageUrl(b.image.blobId) : 'figure.png';
      return `![${alt}](${url})` + citation(b, ctx);
    }
    case 'ink': {
      const beautified = b.beautified?.active ? beautifiedToMarkdown(b.beautified) : '';
      const svg = ctx.inkToSvg ? ctx.inkToSvg(b) : '';
      return [beautified, svg].filter(Boolean).join('\n\n');
    }
    case 'embed':
      return b.embed ? `*(see: ${b.embed.pageId})*` : '';
  }
}

export function blocksToMarkdown(blocks: BlockSnapshot[], ctx: ExportContext = {}): string {
  return blocks
    .map((b) => blockToMarkdown(b, ctx))
    .filter((s) => s.trim())
    .join('\n\n');
}

export function pageToMarkdown(title: string, blocks: BlockSnapshot[], ctx: ExportContext = {}): string {
  return `# ${title}\n\n${blocksToMarkdown(blocks, ctx)}\n`;
}

// ---------------- LaTeX ----------------

const LATEX_SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

export function escapeLatex(s: string): string {
  return s.replace(/[\\&%$#_{}~^]/g, (c) => LATEX_SPECIAL[c]);
}

/** Inline markdown → LaTeX, preserving $math$ verbatim. */
function inlineToLatex(s: string): string {
  const out: string[] = [];
  const re = /(\$\$[\s\S]+?\$\$|\$(?=\S)(?:\\\$|[^$\n])+?\$|`[^`]+`)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    out.push(convertInlineText(s.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('$$')) out.push('\\[' + tok.slice(2, -2).trim() + '\\]');
    else if (tok.startsWith('$')) out.push(tok);
    else out.push('\\texttt{' + escapeLatex(tok.slice(1, -1)) + '}');
    last = m.index! + tok.length;
  }
  out.push(convertInlineText(s.slice(last)));
  return out.join('');
}

function convertInlineText(s: string): string {
  // links first so their URLs are not escaped
  const parts: string[] = [];
  const linkRe = /\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  let last = 0;
  for (const m of s.matchAll(linkRe)) {
    parts.push(styleText(s.slice(last, m.index)));
    parts.push(`\\href{${m[2]}}{${styleText(m[1])}}`);
    last = m.index! + m[0].length;
  }
  parts.push(styleText(s.slice(last)));
  return parts.join('');
}

function styleText(s: string): string {
  let t = escapeLatex(s);
  t = t.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}').replace(/\\_\\_(.+?)\\_\\_/g, '\\textbf{$1}');
  t = t.replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1\\emph{$2}').replace(/(^|\W)\\_(?!\s)(.+?)\\_(?=\W|$)/g, '$1\\emph{$2}');
  t = t.replace(/~~(.+?)~~/g, '\\sout{$1}');
  return t;
}

export function markdownToLatex(md: string): string {
  const lines = cleanMarkdown(md).split('\n');
  const out: string[] = [];
  let list: 'itemize' | 'enumerate' | null = null;
  let inDisplay = false;
  let displayBuf: string[] = [];
  let inCode = false;
  const closeList = () => {
    if (list) out.push(`\\end{${list}}`);
    list = null;
  };
  for (const line of lines) {
    if (inCode) {
      if (line.startsWith('```')) {
        out.push('\\end{verbatim}');
        inCode = false;
      } else out.push(line);
      continue;
    }
    if (line.startsWith('```')) {
      closeList();
      out.push('\\begin{verbatim}');
      inCode = true;
      continue;
    }
    const trimmed = line.trim();
    if (inDisplay) {
      if (trimmed.endsWith('$$')) {
        displayBuf.push(trimmed.slice(0, -2));
        out.push('\\begin{equation*}\n' + displayBuf.join('\n').trim() + '\n\\end{equation*}');
        inDisplay = false;
        displayBuf = [];
      } else displayBuf.push(line);
      continue;
    }
    if (trimmed.startsWith('$$')) {
      closeList();
      const rest = trimmed.slice(2);
      if (rest.endsWith('$$') && rest.length >= 2) {
        out.push('\\begin{equation*}\n' + rest.slice(0, -2).trim() + '\n\\end{equation*}');
      } else {
        inDisplay = true;
        displayBuf = [rest];
      }
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (h) {
      closeList();
      const cmd = ['section', 'subsection', 'subsubsection', 'paragraph'][h[1].length - 1];
      out.push(`\\${cmd}{${inlineToLatex(h[2])}}`);
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ol = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ul || ol) {
      const kind = ul ? 'itemize' : 'enumerate';
      if (list !== kind) {
        closeList();
        out.push(`\\begin{${kind}}`);
        list = kind;
      }
      out.push('  \\item ' + inlineToLatex((ul ?? ol)![1]));
      continue;
    }
    closeList();
    if (/^>\s?/.test(trimmed)) {
      out.push('\\begin{quote}' + inlineToLatex(trimmed.replace(/^>\s?/, '')) + '\\end{quote}');
      continue;
    }
    out.push(trimmed ? inlineToLatex(trimmed) : '');
  }
  closeList();
  if (inCode) out.push('\\end{verbatim}');
  if (inDisplay) out.push('\\begin{equation*}\n' + displayBuf.join('\n').trim() + '\n\\end{equation*}');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function blockToLatex(b: BlockSnapshot, ctx: ExportContext = {}): string {
  const cite = () => {
    if (!b.anchor || !ctx.source) return '';
    const key = ctx.source(b.anchor.sourceId)?.bib?.bibKey;
    return key ? `~\\cite{${key}}` : '';
  };
  switch (b.type) {
    case 'text':
      return markdownToLatex(b.text) + cite();
    case 'math':
      return '\\begin{equation}\n' + b.text.trim() + '\n\\end{equation}';
    case 'code':
      return '\\begin{verbatim}\n' + b.text + '\n\\end{verbatim}';
    case 'image':
    case 'slide':
      return `\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${b.image?.blobId ?? 'figure'}}\n  \\caption{${escapeLatex(b.image?.alt ?? b.text ?? '')}${cite()}}\n\\end{figure}`;
    case 'ink': {
      if (b.beautified?.active) {
        return b.beautified.items
          .map((it) => (it.kind === 'latex' ? `\\[\n${it.latex}\n\\]` : it.kind === 'text' ? escapeLatex(it.text) : ''))
          .filter(Boolean)
          .join('\n\n');
      }
      return '% (hand-drawn figure — export as SVG)';
    }
    case 'embed':
      return '';
  }
}

export function blocksToLatex(blocks: BlockSnapshot[], ctx: ExportContext = {}): string {
  return blocks
    .map((b) => blockToLatex(b, ctx))
    .filter((s) => s.trim())
    .join('\n\n');
}

export function pageToLatex(title: string, blocks: BlockSnapshot[], ctx: ExportContext = {}): string {
  return [
    '\\documentclass{article}',
    '\\usepackage{amsmath,amssymb,graphicx,hyperref,ulem}',
    `\\title{${escapeLatex(title)}}`,
    '\\begin{document}',
    '\\maketitle',
    '',
    blocksToLatex(blocks, ctx),
    '',
    '\\end{document}',
    '',
  ].join('\n');
}
