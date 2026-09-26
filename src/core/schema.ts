/**
 * Axiom data model.
 *
 * A vault is a set of Yjs documents:
 *  - the INDEX doc (guid "index"): page registry, source registry, flashcards,
 *    lenses, highlights, synced settings. Always loaded.
 *  - one PAGE doc per page (guid = page id): the ordered blocks of that page.
 *    Page docs are loaded lazily and evicted from memory when unused.
 *
 * Every mutation is a CRDT operation, persisted as an append-only update log in
 * IndexedDB, streamed to peers, and periodically committed to Git.
 */

export const INDEX_DOC_ID = 'index';

export type PageKind = 'daily' | 'note' | 'concept' | 'seminar' | 'sidequest';

export interface PageMeta {
  id: string;
  title: string;
  kind: PageKind;
  /** YYYY-MM-DD for daily pages */
  date?: string;
  createdAt: number;
  updatedAt: number;
  /** For seminar notebooks: the source deck they were generated from */
  sourceId?: string;
  aliases?: string[];
  trashed?: boolean;
}

export type BlockType =
  | 'text' // markdown with inline $math$, [[links]], #tags
  | 'math' // display LaTeX
  | 'code'
  | 'ink' // whiteboard / accordion space with strokes
  | 'image'
  | 'slide' // a page/slide of a source rendered as an image (seminar notebooks)
  | 'embed'; // transclusion of another page/block

/** Normalised location inside a source document. */
export interface SourceLocator {
  /** 1-based page (PDF/PPTX) or chapter index (EPUB, 0-based spine index) */
  page?: number;
  chapter?: number;
  /** normalised rect on the page, 0..1 in page space: [x, y, w, h] */
  rect?: [number, number, number, number];
  /** EPUB: fraction scrolled inside the chapter */
  offset?: number;
}

export interface Anchor {
  sourceId: string;
  loc: SourceLocator;
  quote?: string;
  createdAt: number;
}

export interface Stroke {
  id: string;
  /** flattened [x, y, pressure, x, y, pressure, ...] in logical units (block width = 1000) */
  pts: number[];
  color: string;
  size: number;
  tool: 'pen' | 'highlighter';
}

export type BeautifiedItem =
  | { kind: 'text'; x: number; y: number; w: number; h: number; text: string; strokeIds: string[] }
  | { kind: 'latex'; x: number; y: number; w: number; h: number; latex: string; strokeIds: string[] }
  | { kind: 'shape'; svg: string; bbox: [number, number, number, number]; color: string; strokeIds: string[]; shape: string };

export interface Beautified {
  items: BeautifiedItem[];
  /** when true the beautified rendering is shown; raw ink is always preserved */
  active: boolean;
  createdAt: number;
}

export interface ImageRef {
  blobId: string;
  w: number;
  h: number;
  alt?: string;
  mime?: string;
}

export interface EmbedRef {
  pageId: string;
  blockId?: string;
}

/** Logical width of ink coordinate space. Rendering scales to actual width. */
export const INK_LOGICAL_WIDTH = 1000;

export type SourceKind = 'pdf' | 'epub' | 'pptx';

export interface BibMeta {
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxiv?: string;
  url?: string;
  publisher?: string;
  entryType?: string;
  bibKey?: string;
  abstract?: string;
  zoteroKey?: string;
}

export interface TocEntry {
  title: string;
  /** PDF: 1-based page. EPUB: chapter index */
  page?: number;
  chapter?: number;
  children?: TocEntry[];
}

export interface SourceMeta {
  id: string;
  kind: SourceKind;
  title: string;
  fileName: string;
  blobId: string;
  size: number;
  addedAt: number;
  pageCount?: number;
  /** detected presentation deck (landscape pages) */
  isSlides?: boolean;
  bib?: BibMeta;
  toc?: TocEntry[];
  tags?: string[];
  ghostTags?: string[];
  dismissedGhostTags?: string[];
}

/** Per-source reading state; synced so a book re-opens where you left it on any device. */
export interface ViewState {
  loc: SourceLocator;
  zoom: number;
  /** scroll offset in px inside the current page (at zoom) for exact restoration */
  intra?: number;
  updatedAt: number;
}

export interface Highlight {
  id: string;
  sourceId: string;
  loc: SourceLocator;
  /** normalised rects on the page */
  rects: [number, number, number, number][];
  color: string;
  text: string;
  createdAt: number;
}

export interface Lens {
  id: string;
  name: string;
  query: string;
  createdAt: number;
}

export type CardStateName = 'new' | 'learning' | 'review' | 'relearning';

export interface CardRecord {
  id: string;
  pageId: string;
  blockId: string;
  kind: 'cloze' | 'basic';
  /** cloze text containing {{c1::answer}} markers, or front for basic cards */
  front: string;
  back?: string;
  clozeIndex?: number;
  /** hash of the block content the card was generated from */
  srcHash: string;
  // FSRS scheduling
  state: CardStateName;
  due: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview?: number;
  scheduledDays: number;
  elapsedDays: number;
  leech?: boolean;
  suspended?: boolean;
  createdAt: number;
}

export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

export interface ReviewLogEntry {
  cardId: string;
  rating: Rating;
  at: number;
  state: CardStateName;
  scheduledDays: number;
  elapsedDays: number;
}
