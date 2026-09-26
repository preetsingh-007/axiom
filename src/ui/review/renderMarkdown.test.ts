import { describe, expect, it, vi } from 'vitest';
import DOMPurify from 'dompurify';
import { renderMarkdown } from './renderMarkdown';
import { renderCloze } from '../../core/srs/cloze';

describe('renderMarkdown', () => {
  it('renders markdown', () => {
    const html = renderMarkdown('**bold** and *em*\n\n- item');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<li>item</li>');
  });

  it('renders inline and display math with KaTeX without markdown mangling', () => {
    const html = renderMarkdown('Energy $E = m_1 c^2$ and $a_i * b_i$\n\n$$\\sum_{i=1}^n x_i$$');
    expect(html.match(/class="katex"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('katex-display');
    expect(html).not.toContain('<em>');
  });

  it('leaves dollar amounts and code alone', () => {
    const html = renderMarkdown('costs $5 and $10, see `$x$`');
    expect(html).not.toContain('katex');
    expect(html).toContain('<code>$x$</code>');
  });

  it('passes the final HTML through DOMPurify', () => {
    // happy-dom's DOM is not complete enough for DOMPurify's own behaviour to be tested here;
    // verify the renderer always sanitizes its output instead.
    const spy = vi.spyOn(DOMPurify, 'sanitize');
    renderMarkdown('<img src=x onerror="alert(1)"> $x$');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('onerror');
    spy.mockRestore();
  });

  it('renders wiki links as labels and keeps cloze markup', () => {
    expect(renderMarkdown('see [[Entropy|entropy]]')).toContain('<span class="rv-wikilink">entropy</span>');
    const html = renderMarkdown(renderCloze('The {{c1::$\\Delta S$}} of a {{c2::system}}', 1, true));
    expect(html).toContain('<mark class="cloze cloze-revealed">');
    expect(html).toContain('katex');
    expect(renderMarkdown(renderCloze('The {{c1::answer::hint}}', 1, false))).toContain('[hint]');
  });
});
