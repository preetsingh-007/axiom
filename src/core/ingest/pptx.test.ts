import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { deckText, parsePptx } from './pptx';
import type { PptxElement } from './types';

const fixtureBlob = (name: string) => new Blob([readFileSync(join(process.cwd(), 'tests/fixtures', name))]);

type TextEl = Extract<PptxElement, { kind: 'text' }>;

describe('parsePptx (fixture)', () => {
  it('reads size, order, placeholders with layout/master inheritance, bullets, shapes, groups, pictures and notes', async () => {
    const deck = await parsePptx(fixtureBlob('deck.pptx'));
    expect(deck.width).toBe(1280);
    expect(deck.height).toBe(720);
    expect(deck.title).toBe('Axiom Seminar Deck');
    expect(deck.author).toBe('Grace Hopper');
    expect(deck.slides).toHaveLength(3);
    expect(deck.slides.map((s) => s.title)).toEqual(['Local-First Knowledge Systems', 'Why CRDTs?', 'Results']);

    // slide 1: positions inherited from the layout (pt → px: ×96/72)
    const [title, sub] = deck.slides[0].elements as TextEl[];
    expect(title).toMatchObject({ kind: 'text', x: 160, y: 226.66666666666666, w: 960, h: 160, placeholder: 'ctrTitle' });
    expect(title.paragraphs[0]).toMatchObject({ text: 'Local-First Knowledge Systems', size: 44, bold: true, align: 'center' });
    expect(title.paragraphs[0].bullet).toBeUndefined();
    expect(sub.y).toBeCloseTo(400);
    expect(sub.paragraphs[0]).toMatchObject({ size: 20, italic: true, color: '#626878' });
    expect(sub.paragraphs[0].bullet).toBeUndefined();
    expect(deck.slides[0].background).toBe('#FFFFFF'); // from the master

    // slide 2: title/body from the master, bullets & levels, rect with text, group transform
    const s2 = deck.slides[1].elements;
    const t2 = s2[0] as TextEl;
    expect(t2).toMatchObject({ x: 160, w: 960 }); // title ≙ layout ctrTitle
    expect(t2.paragraphs[0].size).toBe(44); // master titleStyle
    const body = s2[1] as TextEl;
    expect(body.y).toBeCloseTo(130 * (96 / 72));
    expect(body.paragraphs.map((p) => [p.text, p.bullet, p.level ?? 0, p.size])).toEqual([
      ['CRDTs converge without coordination', true, 0, 24],
      ['State-based and op-based variants', true, 1, 20],
      ['Local-first means offline by default', true, 0, 24],
      ['1. Numbered item', false, 0, 24],
    ]);
    const box = s2[2] as TextEl;
    expect(box).toMatchObject({ kind: 'text', fill: '#3D5BD9', stroke: '#1D2230', geom: 'rect' });
    expect(box.paragraphs[0]).toMatchObject({ text: 'Box', color: '#FFFFFF', align: 'center' });
    const oval = s2[3];
    expect(oval).toMatchObject({ kind: 'shape', geom: 'ellipse', fill: '#E0A526' });
    // group: child 0..1000pt x 0..400pt mapped onto 60..260pt x 440..520pt → scale 0.2
    expect(oval.x).toBeCloseTo(80);
    expect(oval.y).toBeCloseTo(440 * (96 / 72));
    expect(oval.w).toBeCloseTo(80 * (96 / 72));
    expect(oval.h).toBeCloseTo(80 * (96 / 72));
    const grouped = s2[4] as TextEl;
    expect(grouped.paragraphs[0].text).toBe('Grouped');
    expect(grouped.x).toBeCloseTo((60 + 100) * (96 / 72));

    // slide 3: picture, connector line, background, notes
    const s3 = deck.slides[2];
    expect(s3.background).toBe('#1D2230');
    const pic = s3.elements.find((e) => e.kind === 'image');
    expect(pic).toMatchObject({ kind: 'image', x: 320, y: 140 * (96 / 72), w: 640, h: 400, alt: 'A figure' });
    expect((pic as { url: string }).url).toMatch(/^blob:/);
    const line = s3.elements.find((e) => e.kind === 'shape');
    expect(line).toMatchObject({ geom: 'line', stroke: '#D9463D', h: 0 });
    expect(s3.notes).toBe('Mention the benchmark setup.\nThen take questions.');

    expect(deckText(deck)).toContain('Why CRDTs?');
    deck.dispose();
  });
});

describe('parsePptx (edge cases)', () => {
  it('resolves theme colours with modifiers and normAutofit scaling', async () => {
    const zip = new JSZip();
    const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    const rel = (id: string, type: string, target: string) =>
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
    zip.file('_rels/.rels', `<Relationships>${rel('rId1', 'officeDocument', 'ppt/presentation.xml')}</Relationships>`);
    zip.file('ppt/presentation.xml', `<p:presentation ${A}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`);
    zip.file('ppt/_rels/presentation.xml.rels', `<Relationships>${rel('rId2', 'slide', 'slides/slide1.xml')}</Relationships>`);
    zip.file('ppt/slides/_rels/slide1.xml.rels', `<Relationships>${rel('rId1', 'slideLayout', '../slideLayouts/l.xml')}</Relationships>`);
    zip.file('ppt/slideLayouts/l.xml', `<p:sldLayout ${A}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`);
    zip.file('ppt/slideLayouts/_rels/l.xml.rels', `<Relationships>${rel('rId1', 'slideMaster', '../slideMasters/m.xml')}</Relationships>`);
    zip.file('ppt/slideMasters/m.xml', `<p:sldMaster ${A}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg2"/></p:bgRef></p:bg><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/></p:sldMaster>`);
    zip.file('ppt/slideMasters/_rels/m.xml.rels', `<Relationships>${rel('rId9', 'theme', '../theme/t.xml')}</Relationships>`);
    zip.file('ppt/theme/t.xml', `<a:theme ${A}><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="FF0000"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`);
    zip.file(
      'ppt/slides/slide1.xml',
      `<p:sld ${A}><p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:cNvPr id="2" name="a"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm rot="5400000"><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="roundRect"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></p:spPr></p:sp>
        <p:sp><p:nvSpPr><p:cNvPr id="3" name="b"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="952500"/><a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr>
          <p:txBody><a:bodyPr anchor="ctr"><a:normAutofit fontScale="50000"/></a:bodyPr><a:p><a:r><a:rPr sz="4000"><a:solidFill><a:schemeClr val="tx1"><a:alpha val="50000"/></a:schemeClr></a:solidFill></a:rPr><a:t>Half</a:t></a:r><a:r><a:rPr sz="4000" b="1"/><a:t> bold</a:t></a:r><a:br/><a:r><a:t>next</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`,
    );
    const deck = await parsePptx(new Blob([await zip.generateAsync({ type: 'arraybuffer' })]));
    expect(deck.width).toBe(960);
    const [shape, text] = deck.slides[0].elements;
    expect(shape).toMatchObject({ kind: 'shape', geom: 'roundRect', fill: '#800000', rotation: 90, w: 100 });
    expect(text).toMatchObject({ kind: 'text', verticalAlign: 'middle' });
    const p = (text as TextEl).paragraphs[0];
    expect(p.text).toBe('Half bold\nnext');
    expect(p.size).toBe(20);
    expect(p.color).toBe('rgba(17, 17, 17, 0.5)');
    expect(p.runs?.[1]).toMatchObject({ text: ' bold', bold: true, size: 20 });
    expect(p.bold).toBeUndefined();
    expect(deck.slides[0].background).toBe('#EEEEEE');
    deck.dispose();
  });

  it('rejects non-pptx input', async () => {
    await expect(parsePptx(new Blob(['nope']))).rejects.toThrow(/not a valid PowerPoint/);
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    await expect(parsePptx(new Blob([await zip.generateAsync({ type: 'arraybuffer' })]))).rejects.toThrow(/presentation\.xml/);
  });
});
