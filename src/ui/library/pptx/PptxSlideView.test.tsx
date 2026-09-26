import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePptx } from '../../../core/ingest/pptx';
import { PptxSlideView } from './PptxSlideView';
import { bulletLabels, shapePath } from './geometry';

describe('geometry', () => {
  it('shape paths and bullet labels', () => {
    expect(shapePath('rect', 10, 10)).toBeNull();
    expect(shapePath('ellipse', 10, 20)).toMatch(/^M0 10A5 10/);
    expect(shapePath('line', 10, 0)).toBe('M0 0L10 0');
    expect(
      bulletLabels([
        { text: 'a', bullet: true, bulletChar: 'arabicPeriod' },
        { text: 'b', bullet: true, bulletChar: 'arabicPeriod' },
        { text: 'sub', bullet: true, bulletChar: 'alphaLcParenR', level: 1 },
        { text: 'c', bullet: true, bulletChar: 'arabicPeriod' },
        { text: 'plain' },
        { text: 'x', bullet: true },
        { text: 'y', bullet: true, level: 1 },
      ]),
    ).toEqual(['1.', '2.', 'a)', '3.', null, '•', '–']);
  });
});

describe('PptxSlideView', () => {
  it('renders a scaled slide with positioned elements', async () => {
    const deck = await parsePptx(new Blob([readFileSync(join(process.cwd(), 'tests/fixtures/deck.pptx'))]));
    const html = renderToStaticMarkup(<PptxSlideView deck={deck} slide={deck.slides[1]} width={640} />);
    expect(html).toContain('class="pptx-slide"');
    expect(html).toContain('width:640px;height:360px');
    expect(html).toContain('transform:scale(0.5)');
    expect(html).toContain('Why CRDTs?');
    expect(html).toContain('class="pptx-bullet"');
    expect(html).toContain('<path d="M0 53.33A53.33 53.33'); // ellipse in the group
    const pic = renderToStaticMarkup(<PptxSlideView deck={deck} slide={deck.slides[2]} width={320} />);
    expect(pic).toMatch(/<img class="pptx-el pptx-image"[^>]*src="blob:[^"]+"[^>]*loading="lazy"/);
    expect(pic).toContain('background:#1D2230');
    deck.dispose();
  });
});
