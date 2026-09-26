/**
 * Ink engine (pure, DOM-free except for optional Path2D rendering helpers).
 *
 *  geometry   bbox, lengths, resampling, RDP, hit testing
 *  smoothing  quantisation, one-euro filter, simulated pressure
 *  render     perfect-freehand outlines → Path2D / SVG, cached canvas rendering, SVG export
 *  recognize  offline shape recogniser (line/arrow/circle/ellipse/rectangle/triangle/diamond)
 *  shapes     geometry → SVG fragments, alignment, connector snapping
 *  cluster    selection → shape / writing / leftover clusters
 *  beautify   selection → BeautifiedItem[] (shapes offline, writing via AI)
 */
export * from './geometry';
export * from './smoothing';
export * from './render';
export * from './recognize';
export * from './shapes';
export * from './cluster';
export * from './beautify';
export { sanitizeSvgFragment, safeColor, escapeXml } from './svgsafe';
