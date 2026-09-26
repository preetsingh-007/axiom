import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './render';

describe('renderMarkdown', () => {
  it('renders wiki links, tags and transclusions', () => {
    const html = renderMarkdown('See [[Policy Gradient|PG]] and #rl plus ![[Bellman]]');
    expect(html).toContain('class="md-wikilink"');
    expect(html).toContain('data-page="Policy Gradient"');
    expect(html).toContain('>PG<');
    expect(html).toContain('class="md-tag"');
    expect(html).toContain('data-page="rl"');
    expect(html).toContain('class="md-transclude"');
  });

  it('renders inline and display math with KaTeX', () => {
    const html = renderMarkdown('Inline $a^2+b^2$ and\n\n$$\\int_0^1 x\\,dx$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('md-math-display');
  });

  it('does not treat prices or hex colours as math/tags', () => {
    const html = renderMarkdown('It costs $5 and $10 today; colour #1e90ff; issue #12');
    expect(html).not.toContain('katex');
    expect(html).not.toContain('md-tag');
  });

  it('marks flashcard tags and clozes', () => {
    const html = renderMarkdown('The {{c1::entropy}} is maximal #flashcard');
    expect(html).toContain('md-cloze');
    expect(html).toContain('md-tag-flashcard');
  });
});
