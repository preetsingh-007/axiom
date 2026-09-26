import type { BibMeta, TocEntry } from '../schema';

/** A positioned run of text on a page, in PDF points with origin at the top-left. */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  fontName?: string;
  /** true when the item ends a line according to the PDF producer */
  eol?: boolean;
  /** text rotation in degrees (0 = horizontal, left-to-right); omitted when 0 */
  angle?: number;
  /** style hints when known (synthetic items, tagged PDFs) */
  bold?: boolean;
  italic?: boolean;
}

/** Result of analysing a PDF once at import time. */
export interface PdfAnalysis {
  pageCount: number;
  title?: string;
  bib: BibMeta;
  toc: TocEntry[];
  /** landscape presentation deck */
  isSlides: boolean;
  /** first pages' plain text (used for ghost tags / citation lookup) */
  sampleText: string;
  /** size of page 1 in PDF points (rotation applied) */
  pageSize?: { width: number; height: number };
  /** true when the outline was larger than the configured caps and was cut */
  tocTruncated?: boolean;
}

/** EPUB TOC entries additionally carry the fragment (#id) inside the chapter. */
export interface EpubTocEntry extends TocEntry {
  fragment?: string;
  children?: EpubTocEntry[];
}

export interface EpubChapter {
  id: string;
  href: string;
  title?: string;
}

export interface EpubBook {
  title: string;
  authors: string[];
  language?: string;
  publisher?: string;
  /** dc:date as written (e.g. "1843-09-01") */
  date?: string;
  /** dc:identifier (ISBN / UUID / DOI) */
  identifier?: string;
  toc: EpubTocEntry[];
  chapters: EpubChapter[];
  /** sanitized XHTML body for a chapter; images resolved to object URLs */
  chapterHtml(index: number): Promise<string>;
  /** plain text of the first chapters (ghost tags) */
  sampleText(maxChars?: number): Promise<string>;
  /** resolve an href (relative to chapter `from`, or to the OPF when omitted) to a spine index + fragment */
  resolveHref(href: string, from?: number): { chapter: number; fragment?: string } | null;
  coverUrl?: string;
  dispose(): void;
}

export interface PptxRun {
  text: string;
  size?: number; // pt
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
}

export interface PptxParagraph {
  text: string;
  size?: number; // pt
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  level?: number;
  bullet?: boolean;
  /** bullet glyph ("•") or auto-number scheme ("arabicPeriod") when known */
  bulletChar?: string;
  /** per-run formatting; `text` is the concatenation */
  runs?: PptxRun[];
}

export type PptxElement =
  | {
      kind: 'text';
      x: number;
      y: number;
      w: number;
      h: number;
      paragraphs: PptxParagraph[];
      fill?: string;
      stroke?: string;
      rotation?: number;
      /** preset geometry behind the text (rect, ellipse, roundRect…) */
      geom?: string;
      verticalAlign?: 'top' | 'middle' | 'bottom';
      /** placeholder type (title, body, ctrTitle…) when the shape is a placeholder */
      placeholder?: string;
    }
  | { kind: 'image'; x: number; y: number; w: number; h: number; url: string; rotation?: number; alt?: string }
  | {
      kind: 'shape';
      x: number;
      y: number;
      w: number;
      h: number;
      geom: string;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
      rotation?: number;
    };

export interface PptxSlide {
  index: number;
  elements: PptxElement[];
  background?: string;
  notes?: string;
  /** text of the title placeholder, when present */
  title?: string;
}

export interface PptxDeck {
  title?: string;
  author?: string;
  /** slide size in px (96 dpi) */
  width: number;
  height: number;
  slides: PptxSlide[];
  dispose(): void;
}
