/**
 * Small markdown → sanitized HTML renderer for flashcards: marked for markdown, KaTeX for
 * `$…$` / `$$…$$` (and `\(…\)` / `\[…\]`), DOMPurify for safety. Math is swapped out for
 * placeholders before markdown parsing so `_` and `*` inside TeX are never mangled.
 */
import { marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';

const MATH_RE =
  /(```[\s\S]*?```|`[^`\n]*`)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\((.+?)\\\)|(?<![\\$\w])\$(?!\s)([^$\n`]+?)(?<![\s\\])\$(?![\d$])/g;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function renderMath(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex.trim(), { throwOnError: false, displayMode });
}

export function renderMarkdown(md: string): string {
  const math: { tex: string; display: boolean }[] = [];
  let src = md.replace(MATH_RE, (whole, code: string | undefined, d1?: string, d2?: string, i1?: string, i2?: string) => {
    if (code) return whole;
    const display = d1 !== undefined || d2 !== undefined;
    math.push({ tex: (d1 ?? d2 ?? i1 ?? i2)!, display });
    const token = `@@AXM${math.length - 1}@@`;
    return display ? `\n\n${token}\n\n` : token;
  });
  // [[Page]] / [[Page|label]] → styled label (links are not navigable inside a card)
  src = src.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, target: string, label?: string) =>
    `<span class="rv-wikilink">${escapeHtml((label ?? target).trim())}</span>`,
  );
  let html = marked.parse(src, { async: false, gfm: true, breaks: true }) as string;
  html = html
    .replace(/<p>@@AXM(\d+)@@<\/p>/g, (_, i: string) => renderMath(math[+i].tex, true))
    .replace(/@@AXM(\d+)@@/g, (_, i: string) => renderMath(math[+i].tex, math[+i].display));
  return DOMPurify.sanitize(html);
}
