import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { LRU } from '../../core/util/lru';

/**
 * Markdown → HTML for Axiom blocks.
 * Extensions: $inline$ / $$display$$ math (KaTeX), [[wiki links]], ![[transclusions]],
 * #tags / #[[multi word tags]], {{c1::cloze}} and ((block refs)).
 * Output is sanitised; results are cached because the same text renders many times.
 */

const mathCache = new LRU<string, string>(4000);

export function renderMath(tex: string, display: boolean): string {
  const key = (display ? 'D' : 'I') + tex;
  const hit = mathCache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
  } catch {
    html = `<code class="math-error">${escapeHtml(tex)}</code>`;
  }
  mathCache.set(key, html);
  return html;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const displayMath: TokenizerAndRendererExtension = {
  name: 'displayMath',
  level: 'block',
  start: (src) => src.match(/^\s*\$\$/m)?.index,
  tokenizer(src) {
    const m = /^\s*\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src);
    if (m) return { type: 'displayMath', raw: m[0], text: m[1].trim() };
    return undefined;
  },
  renderer: (t) => `<div class="md-math-display">${renderMath((t as Tokens.Generic).text, true)}</div>`,
};

const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start: (src) => {
    const i = src.indexOf('$');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    let m = /^\$\$([\s\S]+?)\$\$/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: true };
    // pandoc rule: no whitespace right inside the delimiters, closing $ not followed by a digit
    m = /^\$(?=\S)((?:\\\$|[^$\n])+?)(?<=\S)\$(?!\d)/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1], display: false };
    return undefined;
  },
  renderer: (t) => {
    const tok = t as Tokens.Generic;
    return tok.display ? `<span class="md-math-block">${renderMath(tok.text, true)}</span>` : renderMath(tok.text, false);
  },
};

const wikiLink: TokenizerAndRendererExtension = {
  name: 'wikiLink',
  level: 'inline',
  start: (src) => {
    const i = src.search(/!?\[\[/);
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^(!?)\[\[([^\[\]\n]+?)\]\]/.exec(src);
    if (!m) return undefined;
    const [target, alias] = m[2].split('|');
    const [page, block] = target.split('#^');
    return { type: 'wikiLink', raw: m[0], embed: m[1] === '!', page: page.trim(), block: block?.trim(), alias: alias?.trim() };
  },
  renderer: (t) => {
    const tok = t as Tokens.Generic;
    const page = escapeHtml(tok.page);
    if (tok.embed) {
      return `<span class="md-transclude" data-page="${page}"${tok.block ? ` data-block="${escapeHtml(tok.block)}"` : ''}></span>`;
    }
    return `<a class="md-wikilink" data-page="${page}" href="#">${escapeHtml(tok.alias || tok.page)}</a>`;
  },
};

const tag: TokenizerAndRendererExtension = {
  name: 'tag',
  level: 'inline',
  start: (src) => {
    const m = /(^|[\s(])#[\p{L}\p{N}_[]/u.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    let m = /^#\[\[([^\[\]\n]+)\]\]/.exec(src);
    if (m) return { type: 'tag', raw: m[0], tag: m[1].trim() };
    m = /^#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/u.exec(src);
    if (!m) return undefined;
    const name = m[1].replace(/[-/]+$/, '');
    // require a letter (skip "#1" issue refs) and skip hex colours like #1e90ff
    if (!/\p{L}/u.test(name) || (/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(name) && /\d/.test(name))) return undefined;
    return { type: 'tag', raw: '#' + name, tag: name };
  },
  renderer: (t) => {
    const tok = t as Tokens.Generic;
    const cls = tok.tag.toLowerCase() === 'flashcard' ? 'md-tag md-tag-flashcard' : 'md-tag';
    return `<a class="${cls}" data-page="${escapeHtml(tok.tag)}" href="#">#${escapeHtml(tok.tag)}</a>`;
  },
};

const cloze: TokenizerAndRendererExtension = {
  name: 'cloze',
  level: 'inline',
  start: (src) => {
    const i = src.indexOf('{{c');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^\{\{c(\d+)::([\s\S]+?)(?:::([^}]*))?\}\}/.exec(src);
    if (!m) return undefined;
    return { type: 'cloze', raw: m[0], n: m[1], text: m[2], tokens: this.lexer.inlineTokens(m[2]) };
  },
  renderer(t) {
    const tok = t as Tokens.Generic;
    return `<span class="md-cloze" data-c="${escapeHtml(tok.n)}">${this.parser.parseInline(tok.tokens ?? [])}</span>`;
  },
};

const blockRef: TokenizerAndRendererExtension = {
  name: 'blockRef',
  level: 'inline',
  start: (src) => {
    const i = src.indexOf('((');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^\(\(([A-Za-z0-9_-]{6,})\)\)/.exec(src);
    if (!m) return undefined;
    return { type: 'blockRef', raw: m[0], id: m[1] };
  },
  renderer: (t) => `<span class="md-blockref" data-block="${escapeHtml((t as Tokens.Generic).id)}">↗</span>`,
};

const marked = new Marked({
  gfm: true,
  breaks: true,
  extensions: [displayMath, inlineMath, wikiLink, tag, cloze, blockRef],
});

// Open external links in a new tab; keep internal links inert (handled by delegation).
marked.use({
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = /^(https?:|mailto:|#)/i.test(href) ? href : '#';
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</a>`;
    },
  },
});

let purifyReady = false;
function purify(html: string): string {
  if (!purifyReady) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('target') === '_blank') node.setAttribute('rel', 'noopener noreferrer');
    });
    purifyReady = true;
  }
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-page', 'data-block', 'data-c', 'aria-hidden', 'encoding'],
    ADD_TAGS: ['semantics', 'annotation'],
  });
}

const htmlCache = new LRU<string, string>(5000);

/** Renders block markdown to sanitised HTML (cached). */
export function renderMarkdown(text: string): string {
  const hit = htmlCache.get(text);
  if (hit !== undefined) return hit;
  const raw = marked.parse(text, { async: false }) as string;
  const html = purify(raw);
  htmlCache.set(text, html);
  return html;
}

/** Inline-only rendering (no paragraphs) for titles/snippets. */
export function renderInline(text: string): string {
  const key = '\u0000i' + text;
  const hit = htmlCache.get(key);
  if (hit !== undefined) return hit;
  const html = purify(marked.parseInline(text, { async: false }) as string);
  htmlCache.set(key, html);
  return html;
}
