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
  toc: TocEntry[];
  chapters: EpubChapter[];
  /** sanitized XHTML body for a chapter; images resolved to object URLs */
  chapterHtml(index: number): Promise<string>;
  /** plain text of the first chapters (ghost tags) */
  sampleText(maxChars?: number): Promise<string>;
  coverUrl?: string;
  dispose(): void;
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
}

export type PptxElement =
  | { kind: 'text'; x: number; y: number; w: number; h: number; paragraphs: PptxParagraph[]; fill?: string; rotation?: number }
  | { kind: 'image'; x: number; y: number; w: number; h: number; url: string; rotation?: number }
  | { kind: 'shape'; x: number; y: number; w: number; h: number; geom: string; fill?: string; stroke?: string; rotation?: number };

export interface PptxSlide {
  index: number;
  elements: PptxElement[];
  background?: string;
  notes?: string;
}

export interface PptxDeck {
  title?: string;
  /** slide size in px (96 dpi) */
  width: number;
  height: number;
  slides: PptxSlide[];
  dispose(): void;
}
