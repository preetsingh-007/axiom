import { describe, expect, it } from 'vitest';
import { coveredStrokeIds, inkToSvg, strokeOutline, strokeToSvgPath, CURRENT_INK } from './render';
import { sanitizeSvgFragment } from './svgsafe';
import { densify, toStroke } from './testing/synth';
import type { Beautified } from '../schema';

describe('render', () => {
  const pen = toStroke(densify([{ x: 10, y: 10 }, { x: 200, y: 40 }]), { size: 4 });
  const hl = toStroke(densify([{ x: 10, y: 80 }, { x: 200, y: 80 }]), { size: 20, tool: 'highlighter', color: '#ffd60a' });

  it('produces outlines and svg paths', () => {
    expect(strokeOutline(pen).length).toBeGreaterThan(8);
    const d = strokeToSvgPath(pen);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    // a single tap still renders as a dot
    expect(strokeToSvgPath(toStroke([{ x: 5, y: 5 }]))).not.toBe('');
  });

  it('exports standalone SVG with resolved colours and highlighter opacity', () => {
    const svg = inkToSvg([pen, hl], null, 1000, 300, { inkColor: '#000000' });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 1000 300"/);
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain('fill="#ffd60a" fill-opacity="0.35"');
    expect(svg).not.toContain(CURRENT_INK);
  });

  it('replaces covered strokes by beautified items when active, and crops', () => {
    const b: Beautified = {
      active: true,
      createdAt: 0,
      items: [
        { kind: 'shape', shape: 'circle', svg: '<circle cx="50" cy="50" r="20" fill="none" stroke="currentColor"/>', bbox: [30, 30, 40, 40], color: '#3e7bfa', strokeIds: [pen.id] },
        { kind: 'text', x: 10, y: 100, w: 100, h: 30, text: 'a < b', strokeIds: ['x'] },
      ],
    };
    expect([...coveredStrokeIds(b)]).toEqual([pen.id, 'x']);
    const svg = inkToSvg([pen, hl], b, 1000, 300, { crop: true, padding: 0 });
    expect(svg).toContain('<circle cx="50" cy="50" r="20"');
    expect(svg).toContain('a &lt; b');
    expect(svg.match(/<path /g)?.length).toBe(1); // only the highlighter remains as ink
    expect(svg).toContain('viewBox="10 30');
    const inactive = inkToSvg([pen, hl], { ...b, active: false }, 1000, 300);
    expect(inactive.match(/<path /g)?.length).toBe(2);
  });
});

describe('svg sanitiser', () => {
  it('keeps geometry, drops scripts, handlers and foreign elements', () => {
    const dirty =
      '<g transform="translate(1 2)"><path d="M0 0L10 10" stroke="currentColor" onload="alert(1)"/><script>alert(1)</script>' +
      '<image href="x" onerror="alert(1)"/><rect x="1" y="2" width="3" height="4" fill="url(javascript:alert(1))" style="x"/></g><foreignObject/>';
    const clean = sanitizeSvgFragment(dirty);
    expect(clean).toBe('<g transform="translate(1 2)"><path d="M0 0L10 10" stroke="currentColor"/><rect x="1" y="2" width="3" height="4"/></g>');
  });

  it('balances unclosed groups', () => {
    expect(sanitizeSvgFragment('<g><circle cx="1" cy="1" r="1"/>')).toBe('<g><circle cx="1" cy="1" r="1"/></g>');
    expect(sanitizeSvgFragment('</g></g><line x1="0" y1="0" x2="1" y2="1"/>')).toBe('<line x1="0" y1="0" x2="1" y2="1"/>');
  });
});
