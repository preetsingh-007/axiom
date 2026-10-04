import { describe, expect, it } from 'vitest';
import type { TextItem } from './types';
import {
  classifySelection,
  estimateBodyFontSize,
  extractSelection,
  itemsToLatex,
  itemsToMarkdown,
  itemsToText,
  joinLines,
  looksLikeMath,
  polygonArea,
  selectItemsInPolygon,
  unicodeMathToLatex,
  type Point,
} from './extract';

/** Synthetic item: top-left origin, width ≈ 0.5em per char. */
function item(str: string, x: number, y: number, fontSize = 10, extra: Partial<TextItem> = {}): TextItem {
  return { str, x, y, w: str.length * fontSize * 0.5, h: fontSize, fontSize, ...extra };
}

/** Lines of a column starting at (x, y) with the given leading. */
function column(lines: string[], x: number, y: number, fs = 10, lead = 12): TextItem[] {
  return lines.map((l, i) => item(l, x, y + i * lead, fs));
}

const LEFT = 54;
const RIGHT = 315;

function twoColumnPage(): TextItem[] {
  const items: TextItem[] = [];
  items.push(item('Semantic Reading Order for Notebooks', 150, 60, 18));
  items.push(item('Ada Lovelace, Alan Turing', 240, 88, 11));
  // left column
  items.push(item('1 Introduction', LEFT, 120, 12));
  items.push(
    ...column(
      [
        'Researchers read many papers and the act of',
        'excerpting a passage should preserve its infor-',
        'mation rather than flatten it into a picture.',
        'Local-first software keeps data on the device.',
      ],
      LEFT,
      138,
    ),
  );
  items.push(
    ...column(['A second paragraph begins after a gap and', 'continues on the next line of the column.'], LEFT, 200),
  );
  // right column (baselines aligned with the left one)
  items.push(item('2 Method', RIGHT, 120, 12));
  items.push(
    ...column(
      [
        'We cluster items into columns by detecting a',
        'wide vertical gutter between the two columns',
        'and then read each column from top to bottom.',
      ],
      RIGHT,
      138,
    ),
  );
  return items;
}

describe('estimateBodyFontSize', () => {
  it('returns the character-weighted median size', () => {
    expect(estimateBodyFontSize(twoColumnPage())).toBe(10);
    expect(estimateBodyFontSize([])).toBe(10);
  });
});

describe('itemsToMarkdown — layout', () => {
  it('reads a two-column paper column by column, with headings and de-hyphenation', () => {
    const md = itemsToMarkdown(twoColumnPage());
    const blocks = md.split('\n\n');
    expect(blocks[0]).toBe('# Semantic Reading Order for Notebooks');
    expect(blocks[1]).toBe('Ada Lovelace, Alan Turing');
    expect(blocks[2]).toBe('## 1 Introduction');
    expect(blocks[3]).toContain('preserve its information rather than flatten');
    expect(blocks[3]).toMatch(/^Researchers read many papers/);
    expect(blocks[4]).toMatch(/^A second paragraph begins after a gap and continues/);
    expect(blocks[5]).toBe('## 2 Method');
    expect(blocks[6]).toBe(
      'We cluster items into columns by detecting a wide vertical gutter between the two columns and then read each column from top to bottom.',
    );
    expect(blocks).toHaveLength(7);
  });

  it('handles items given in arbitrary order', () => {
    const items = twoColumnPage();
    const shuffled = [...items].reverse();
    expect(itemsToMarkdown(shuffled)).toBe(itemsToMarkdown(items));
  });

  it('keeps full-width floats between the column blocks', () => {
    const items: TextItem[] = [
      ...column(['Left top line one of the text body here', 'Left top line two of the text body here'], LEFT, 100),
      ...column(['Right top line one of the text body now', 'Right top line two of the text body now'], RIGHT, 100),
      item('Figure 1: A caption that spans the entire width of the page body text', 60, 160, 10),
      ...column(['Left bottom line of the paper body text'], LEFT, 200),
      ...column(['Right bottom line of the paper body text'], RIGHT, 200),
    ];
    const text = itemsToText(items);
    const order = ['Left top line one', 'Right top line one', 'Figure 1', 'Left bottom', 'Right bottom'].map((s) =>
      text.indexOf(s),
    );
    expect(order.every((v) => v >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('reads per-word items of a single column as lines with spaces', () => {
    const words = ['The', 'quick', 'brown', 'fox'];
    const items: TextItem[] = [];
    let x = 72;
    for (const w of words) {
      items.push(item(w, x, 100));
      x += w.length * 5 + 2.5;
    }
    expect(itemsToMarkdown(items)).toBe('The quick brown fox');
  });

  it('does not mistake wide justified word spacing (explicit space items) for column gutters', () => {
    // Chrome-printed PDFs: a justified line is drawn word by word, each gap a separate ' ' item
    const words = (line: string, x: number, y: number, gap: number) => {
      const out: TextItem[] = [];
      for (const w of line.split(' ')) {
        const it = item(w, x, y);
        out.push(it, item(' ', x + it.w, y, 10, { w: gap }));
        x += it.w + gap;
      }
      return out.slice(0, -1);
    };
    const items = [
      item('make this adjustment explicit by following', LEFT, 120),
      ...words('parameters. Their appeal is generality:', LEFT, 132, 9),
      ...words('they handle continuous actions,', LEFT, 144, 12),
      ...column(['Conflict-free replicated data types provide strong', 'eventual consistency without a coordinator.'], RIGHT, 120),
    ];
    const md = itemsToMarkdown(items);
    expect(md).toContain('explicit by following parameters. Their appeal is generality: they handle continuous actions,');
    expect(md).not.toMatch(/Their\n/);
    expect(md.indexOf('Conflict-free')).toBeGreaterThan(md.indexOf('actions,'));
  });

  it('breaks paragraphs on first-line indentation', () => {
    const items = [
      ...column(['This paragraph has two lines of text that', 'fill the column to its right margin edge.'], 72, 100),
      item('Indented start of a new paragraph that is', 84, 124),
      item('long enough to reach the right margin too.', 72, 136),
    ];
    const md = itemsToMarkdown(items);
    expect(md.split('\n\n')).toHaveLength(2);
    expect(md.split('\n\n')[1]).toMatch(/^Indented start/);
  });

  it('breaks after short sentence-final lines', () => {
    const items = column(
      ['A full line of text that reaches the margin.', 'Short end.', 'Next paragraph starts right here without gap'],
      72,
      100,
    );
    const md = itemsToMarkdown(items);
    expect(md).toBe('A full line of text that reaches the margin. Short end.\n\nNext paragraph starts right here without gap');
  });

  it('reads tables row-wise rather than column-wise', () => {
    const items = [
      item('Model', 72, 100),
      item('Score', 260, 100),
      item('GPT', 72, 112),
      item('0.91', 260, 112),
      item('BERT', 72, 124),
      item('0.88', 260, 124),
    ];
    const text = itemsToText(items);
    expect(text.indexOf('GPT')).toBeLessThan(text.indexOf('0.91'));
    expect(text.indexOf('0.91')).toBeLessThan(text.indexOf('BERT'));
  });

  it('drops rotated side banners by default and can keep them', () => {
    const items = [item('Body text line here', 72, 100), item('arXiv:2101.00001v2 [cs.LG]', 20, 300, 20, { angle: 90 })];
    expect(itemsToMarkdown(items)).toBe('Body text line here');
    expect(itemsToMarkdown(items, { keepRotated: true })).toContain('arXiv:2101.00001v2');
  });
});

describe('itemsToMarkdown — structure', () => {
  it('detects bullet and numbered lists with continuation lines', () => {
    const items = [
      item('Key ideas:', 72, 88),
      item('•', 72, 100),
      item('Columns are found by gap detection', 84, 100),
      item('•', 72, 112),
      item('Paragraphs are split on vertical gaps and', 84, 112),
      item('indentation changes.', 84, 124),
      item('1. Numbered item one', 72, 136),
      item('2) Numbered item two', 72, 148),
    ];
    const md = itemsToMarkdown(items);
    expect(md).toBe(
      [
        'Key ideas:',
        '',
        '- Columns are found by gap detection',
        '- Paragraphs are split on vertical gaps and indentation changes.',
        '1. Numbered item one',
        '2. Numbered item two',
      ].join('\n'),
    );
  });

  it('uses bodyFontSize from the page so a lassoed heading stays a heading', () => {
    const items = [item('3 Results', 72, 100, 14)];
    expect(itemsToMarkdown(items)).toBe('3 Results');
    expect(itemsToMarkdown(items, { bodyFontSize: 10 })).toBe('## 3 Results');
    expect(itemsToMarkdown([item('Big Title', 72, 100, 20)], { bodyFontSize: 10 })).toBe('# Big Title');
    expect(itemsToMarkdown(items, { bodyFontSize: 10, headings: false })).toBe('3 Results');
  });

  it('writes superscripts/subscripts', () => {
    const items = [
      item('Energy is E = mc', 72, 100),
      item('2', 72 + 16 * 5, 96, 7), // raised
      item(' and water is H', 72 + 16 * 5 + 3.5, 100),
      item('2', 72 + 31 * 5 + 3.5, 104, 7), // lowered
      item('O.', 72 + 31 * 5 + 7, 100),
    ];
    expect(itemsToMarkdown(items)).toBe('Energy is E = mc² and water is H₂O.');
    expect(itemsToMarkdown(items, { scripts: 'html' })).toBe('Energy is E = mc<sup>2</sup> and water is H<sub>2</sub>O.');
    expect(itemsToMarkdown(items, { scripts: 'latex' })).toBe('Energy is E = mc$^{2}$ and water is H$_{2}$O.');
  });

  it('falls back to html tags for scripts without unicode forms', () => {
    const items = [item('See note', 72, 100), item('abc', 72 + 40, 96, 6)];
    expect(itemsToMarkdown(items)).toBe('See note<sup>abc</sup>');
  });

  it('escapes markdown metacharacters and accidental list starts', () => {
    const items = [item('Costs $5 *per* item_name', 72, 100)];
    expect(itemsToMarkdown(items)).toBe('Costs \\$5 \\*per\\* item\\_name');
    expect(itemsToMarkdown([item('# not a heading', 72, 100)])).toBe('\\# not a heading');
    expect(itemsToMarkdown(items, { escape: false })).toBe('Costs $5 *per* item_name');
  });

  it('emits bold/italic when style hints are present', () => {
    const items = [item('Theorem 1.', 72, 100, 10, { bold: true }), item('Every set is fine.', 125, 100, 10, { italic: true })];
    expect(itemsToMarkdown(items)).toBe('**Theorem 1.** *Every set is fine.*');
  });

  it('returns empty output for empty/whitespace input', () => {
    expect(itemsToMarkdown([])).toBe('');
    expect(itemsToMarkdown([item('   ', 0, 0)])).toBe('');
  });
});

describe('joinLines (de-hyphenation)', () => {
  it('joins broken words and keeps real hyphens', () => {
    expect(joinLines(['infor-', 'mation'])).toBe('information');
    expect(joinLines(['state-of-the-', 'art methods'])).toBe('state-of-the-art methods');
    expect(joinLines(['COVID-', '19 cases'])).toBe('COVID-19 cases');
    expect(joinLines(['soft­', 'ware'])).toBe('software');
    expect(joinLines(['a dash -', 'here'])).toBe('a dash - here');
    expect(joinLines(['plain', 'join'])).toBe('plain join');
  });
});

describe('math', () => {
  it('looksLikeMath', () => {
    expect(looksLikeMath('∑ α i x i ≤ β')).toBe(true);
    expect(looksLikeMath('x = y + 2')).toBe(true);
    expect(looksLikeMath('E = mc²')).toBe(true);
    expect(looksLikeMath('f(x) = \\frac{1}{x}')).toBe(true);
    expect(looksLikeMath('The objective above is minimized with respect to the parameters.')).toBe(false);
    expect(looksLikeMath('')).toBe(false);
    expect(looksLikeMath('Chapter 3')).toBe(false);
  });

  it('unicodeMathToLatex', () => {
    expect(unicodeMathToLatex('α² + β₁ ≤ √x')).toBe('\\alpha^{2} + \\beta_{1} \\leq \\sqrt{x}');
    expect(unicodeMathToLatex('∑ᵢ xᵢ → ∞')).toBe('\\sum_{i} x_{i} \\to \\infty');
    expect(unicodeMathToLatex('∀x ∈ ℝ, ∃y ∉ A ∪ B')).toBe('\\forall x \\in \\mathbb{R}, \\exists y \\notin A \\cup B');
    expect(unicodeMathToLatex('√(a+b) = ½')).toBe('\\sqrt{a+b} = \\frac{1}{2}');
    expect(unicodeMathToLatex('sin θ ≈ θ')).toBe('\\sin \\theta \\approx \\theta');
    expect(unicodeMathToLatex('∫₀¹ f(x) dx')).toBe('\\int_{0}^{1} f(x) dx');
    expect(unicodeMathToLatex('50% of {a}')).toBe('50\\% of \\{a\\}');
    expect(unicodeMathToLatex('αβ')).toBe('\\alpha\\beta');
    expect(unicodeMathToLatex('λx')).toBe('\\lambda x');
    expect(unicodeMathToLatex('x⁻¹ ⇒ P ⊆ Q')).toBe('x^{-1} \\Rightarrow P \\subseteq Q');
  });

  it('itemsToLatex rebuilds scripts from geometry and tags equation numbers', () => {
    const items = [
      item('∑', 100, 98, 13),
      item('α', 106.5, 100, 10),
      item('i', 111.5, 104.5, 7), // subscript
      item(' x', 115, 100, 10),
      item('i', 125, 104.5, 7),
      item('2', 125, 96, 7), // superscript above the subscript
      item(' ≤ β', 129, 100, 10),
      item('(1)', 250, 100, 10),
    ];
    expect(itemsToLatex(items)).toBe('\\sum\\alpha_{i} x_{i}^{2} \\leq \\beta \\tag{1}');
  });

  it('classifySelection', () => {
    const math = [item('∑', 100, 98, 13), item('α', 106.5, 100), item('i', 111.5, 102, 7), item(' ≤ β', 129, 100)];
    expect(classifySelection(math, 60 * 20)).toBe('math');
    const prose = column(['This is ordinary running text in a paper', 'with several words per line and so on.'], 72, 100);
    expect(classifySelection(prose, 220 * 30)).toBe('text');
    expect(classifySelection([], 1000)).toBe('figure');
    const axis = [item('0', 50, 300, 8), item('10', 150, 300, 8), item('20', 250, 300, 8), item('30', 350, 300, 8)];
    expect(classifySelection(axis, 350 * 250)).toBe('figure');
  });
});

describe('selection', () => {
  const page = twoColumnPage();
  it('selects items by centre (and partial overlap) inside a lasso polygon', () => {
    // lasso around the right column only
    const poly: Point[] = [
      [RIGHT - 5, 115],
      [RIGHT + 250, 115],
      [RIGHT + 250, 180],
      [RIGHT - 5, 180],
    ];
    const sel = selectItemsInPolygon(page, poly);
    expect(sel.length).toBe(4);
    expect(sel.every((s) => s.x >= RIGHT)).toBe(true);
    expect(polygonArea(poly)).toBeCloseTo(255 * 65);
  });

  it('triangle lasso excludes items whose centre and most of their box are outside', () => {
    const tri: Point[] = [
      [0, 0],
      [60, 0],
      [0, 60],
    ];
    expect(selectItemsInPolygon([item('far', 100, 100)], tri)).toHaveLength(0);
    expect(selectItemsInPolygon([item('in', 5, 5)], tri)).toHaveLength(1);
    expect(selectItemsInPolygon([item('x', 0, 0)], [[0, 0], [1, 1]])).toHaveLength(0);
  });

  it('extractSelection produces markdown for text and $$latex$$ for math', () => {
    const poly: Point[] = [
      [LEFT - 5, 115],
      [LEFT + 250, 115],
      [LEFT + 250, 190],
      [LEFT - 5, 190],
    ];
    const sel = extractSelection(page, poly);
    expect(sel.kind).toBe('text');
    expect(sel.markdown.startsWith('## 1 Introduction\n\nResearchers')).toBe(true);
    expect(sel.markdown).toContain('information');

    const eq = [item('x', 100, 100), item('2', 105, 96, 7), item(' + y = 1', 108.5, 100)];
    const eqSel = extractSelection([...page, ...eq], [
      [95, 90],
      [160, 90],
      [160, 112],
      [95, 112],
    ]);
    expect(eqSel.kind).toBe('math');
    expect(eqSel.latex).toBe('x^{2} + y = 1');
    expect(eqSel.markdown).toBe('$$\nx^{2} + y = 1\n$$');
  });
});
