import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { BookOpen, CalendarClock, ExternalLink, Flame, Sparkles, TriangleAlert, Undo2, X } from 'lucide-react';
import type { Anchor, CardRecord, Rating } from '../../core/schema';
import type { Vault } from '../../core/vault';
import { blockAnchor, getBlock } from '../../core/blocks';
import { preview, RATINGS } from '../../core/srs/fsrs';
import { renderCloze } from '../../core/srs/cloze';
import {
  answer as answerCard,
  buildQueue,
  setCardFlags,
  stats,
  undoAnswer,
  type AnswerOptions,
  type AnswerResult,
  type QueueOptions,
} from '../../core/srs/queue';
import { renderMarkdown } from './renderMarkdown';
import './ReviewView.css';

export interface ReviewViewProps {
  vault: Vault;
  /** renders a block read-only (used as the answer of basic cards) */
  renderBlock: (pageId: string, blockId: string) => ReactNode;
  /** opens the source location a block is tethered to (Wormhole Anchor) */
  onOpenAnchor: (anchor: Anchor) => void;
  onOpenPage: (pageId: string, blockId?: string) => void;
  /** queue limits and leech policy */
  options?: QueueOptions & AnswerOptions;
}

const RATING_UI: Record<Rating, { label: string; tone: string }> = {
  1: { label: 'Again', tone: 'again' },
  2: { label: 'Hard', tone: 'hard' },
  3: { label: 'Good', tone: 'good' },
  4: { label: 'Easy', tone: 'easy' },
};

const REFRESH_MS = 30_000;
const UNDO_DEPTH = 20;

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** "in 12 min", "in 3 h", "tomorrow, 09:30", "Fri, 09:30". */
export function formatWhen(ts: number, now: number): string {
  const diff = ts - now;
  if (diff <= 60_000) return 'now';
  if (diff < 3600_000) return `in ${Math.round(diff / 60_000)} min`;
  if (diff < 6 * 3600_000) return `in ${Math.round(diff / 3600_000)} h`;
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `today, ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow, ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** Looks up the Wormhole Anchor of a card's block (undefined while loading, null if none). */
function useBlockAnchor(vault: Vault, card: CardRecord): Anchor | null | undefined {
  const [state, setState] = useState<{ key: string; anchor: Anchor | null } | null>(null);
  const key = `${card.pageId}/${card.blockId}`;
  const { pageId, blockId } = card;
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    vault
      .openPage(pageId)
      .then((page) => {
        release = page.release;
        const block = getBlock(page.doc, blockId);
        if (!cancelled) setState({ key, anchor: (block && blockAnchor(block)) ?? null });
      })
      .catch(() => !cancelled && setState({ key, anchor: null }))
      .finally(() => release?.());
    return () => {
      cancelled = true;
    };
  }, [vault, key, pageId, blockId]);
  return state?.key === key ? state.anchor : undefined;
}

/** Bumps on any change to the cards map or the review log (shallow observers: cheap). */
function useReviewData(vault: Vault): number {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const cards = vault.cards;
    const log = vault.reviewLog;
    cards.observe(bump);
    log.observe(bump);
    return () => {
      cards.unobserve(bump);
      log.unobserve(bump);
    };
  }, [vault]);
  return version;
}

function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

interface LeechCalloutProps {
  vault: Vault;
  card: CardRecord;
  onOpenAnchor: (anchor: Anchor) => void;
  onOpenPage: (pageId: string, blockId?: string) => void;
  onDismiss: () => void;
  justBecame?: boolean;
}

function LeechCallout({ vault, card, onOpenAnchor, onOpenPage, onDismiss, justBecame }: LeechCalloutProps) {
  const anchor = useBlockAnchor(vault, card);
  const source = anchor ? vault.getSource(anchor.sourceId) : undefined;
  return (
    <div className="rv-leech" role="status">
      <TriangleAlert className="rv-leech-icon" size={20} aria-hidden />
      <div className="rv-leech-body">
        <strong>This card keeps slipping — revisit the source</strong>
        <p>
          {justBecame ? 'You have forgotten it ' : 'Forgotten '}
          {card.lapses} times. Re-reading the original context usually fixes what drilling can’t.
        </p>
        {anchor?.quote && <blockquote className="rv-leech-quote">“{anchor.quote}”</blockquote>}
        <div className="rv-leech-actions">
          {anchor ? (
            <button type="button" className="rv-btn rv-btn-primary" onClick={() => onOpenAnchor(anchor)}>
              <BookOpen size={16} aria-hidden />
              Re-read {source?.title ? <span className="rv-leech-src">{source.title}</span> : 'the source'}
              {anchor.loc.page ? ` · p. ${anchor.loc.page}` : ''}
            </button>
          ) : (
            <button
              type="button"
              className="rv-btn rv-btn-primary"
              disabled={anchor === undefined}
              onClick={() => onOpenPage(card.pageId, card.blockId)}
            >
              <ExternalLink size={16} aria-hidden />
              Open the note
            </button>
          )}
          <button
            type="button"
            className="rv-btn rv-btn-ghost"
            onClick={() => {
              setCardFlags(vault, card.id, { leech: false });
              onDismiss();
            }}
          >
            Mark as fixed
          </button>
        </div>
      </div>
      <button type="button" className="rv-icon-btn" aria-label="Dismiss" onClick={onDismiss}>
        <X size={16} />
      </button>
    </div>
  );
}

function Forecast({ counts, now }: { counts: number[]; now: number }) {
  const max = Math.max(1, ...counts);
  return (
    <div className="rv-forecast" role="img" aria-label={`Cards due over the next 7 days: ${counts.join(', ')}`}>
      {counts.map((c, i) => {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        const label = i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' });
        return (
          <div key={i} className="rv-forecast-col">
            <span className="rv-forecast-n">{c || ''}</span>
            <div className="rv-forecast-track">
              <div className={`rv-forecast-bar${i === 0 ? ' is-today' : ''}`} style={{ height: `${(c / max) * 100}%` }} />
            </div>
            <span className="rv-forecast-day">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Spaced-repetition review session: queue, card, answer buttons, leech anchoring, undo. */
export function ReviewView({ vault, renderBlock, onOpenAnchor, onOpenPage, options }: ReviewViewProps) {
  const version = useReviewData(vault);
  const [now, setNow] = useState(() => Date.now());
  const [done, setDone] = useState(0);
  const [undoStack, setUndoStack] = useState<AnswerResult[]>([]);
  const [forcedId, setForcedId] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [leechNotice, setLeechNotice] = useState<CardRecord | null>(null);
  const [dismissedLeech, setDismissedLeech] = useState<string | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const queue = useMemo(
    () => buildQueue(vault, now, optsRef.current),
    [vault, now, version],
  );

  const forced = forcedId ? vault.cards.get(forcedId) : undefined;
  const current: CardRecord | null = (forced && !forced.suspended ? forced : queue.cards[0]) ?? null;
  const shownKey = current ? `${current.id}#${current.reps}` : '';
  const revealed = !!current && revealedKey === shownKey;
  const previews = useMemo(() => (current && revealed ? preview(current, Date.now(), optsRef.current?.params) : null), [current, revealed]);

  const remaining = queue.counts.new + queue.counts.learning + queue.counts.review;
  const progress = done + remaining > 0 ? done / (done + remaining) : 0;
  const pageTitle = current ? (vault.getPage(current.pageId)?.title ?? 'Untitled') : '';

  const reveal = useCallback(() => {
    if (current) setRevealedKey(shownKey);
  }, [current, shownKey]);

  const rate = useCallback(
    (rating: Rating) => {
      if (!current || !revealed) return;
      const res = answerCard(vault, current.id, rating, Date.now(), optsRef.current);
      if (!res) return;
      setUndoStack((s) => [...s.slice(-(UNDO_DEPTH - 1)), res]);
      setDone((d) => d + 1);
      setForcedId(null);
      setRevealedKey(null);
      setLeechNotice(res.becameLeech ? res.card : null);
      setNow(Date.now());
    },
    [vault, current, revealed],
  );

  const undo = useCallback(() => {
    const last = undoStack.at(-1);
    if (!last) return;
    undoAnswer(vault, last);
    setUndoStack((s) => s.slice(0, -1));
    setDone((d) => Math.max(0, d - 1));
    setForcedId(last.previous.id);
    setRevealedKey(null);
    setLeechNotice(null);
    setNow(Date.now());
  }, [vault, undoStack]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        if (!undoStack.length) return;
        e.preventDefault();
        undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || !current) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        reveal();
      } else if (revealed && e.key === ' ') {
        e.preventDefault();
        rate(3);
      } else if (revealed && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        rate(Number(e.key) as Rating);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, revealed, reveal, rate, undo, undoStack.length]);

  const header = (
    <header className="rv-header">
      <div className="rv-counts" aria-label="Cards remaining">
        <span className={`rv-count rv-count-new${current?.state === 'new' ? ' is-active' : ''}`} title="New">
          <span className="rv-dot" aria-hidden />
          {queue.counts.new}
          <span className="rv-count-label">new</span>
        </span>
        <span
          className={`rv-count rv-count-learning${current && (current.state === 'learning' || current.state === 'relearning') ? ' is-active' : ''}`}
          title="Learning"
        >
          <span className="rv-dot" aria-hidden />
          {queue.counts.learning}
          <span className="rv-count-label">learning</span>
        </span>
        <span className={`rv-count rv-count-review${current?.state === 'review' ? ' is-active' : ''}`} title="Review">
          <span className="rv-dot" aria-hidden />
          {queue.counts.review}
          <span className="rv-count-label">review</span>
        </span>
      </div>
      <button
        type="button"
        className="rv-btn rv-btn-ghost rv-undo"
        onClick={undo}
        disabled={!undoStack.length}
        title="Undo last answer (Ctrl/⌘ Z)"
      >
        <Undo2 size={16} aria-hidden />
        <span className="rv-undo-label">Undo</span>
      </button>
      <div className="rv-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
        <div className="rv-progress-fill" style={{ transform: `scaleX(${progress})` }} />
      </div>
    </header>
  );

  const notice = leechNotice && leechNotice.id !== current?.id && (
    <LeechCallout
      vault={vault}
      card={leechNotice}
      justBecame
      onOpenAnchor={onOpenAnchor}
      onOpenPage={onOpenPage}
      onDismiss={() => setLeechNotice(null)}
    />
  );

  if (!current) {
    const s = stats(vault, now);
    return (
      <div className="rv-root">
        {header}
        <main className="rv-main">
          {notice}
          <section className="rv-empty rv-enter">
            {vault.cards.size === 0 ? (
              <>
                <Sparkles className="rv-empty-icon" size={28} aria-hidden />
                <h2>No flashcards yet</h2>
                <p className="rv-muted">
                  Tag any block in your notes with <code>#flashcard</code> — Axiom turns it into cloze cards automatically.
                  Use <code>{'{{c1::answer}}'}</code> to choose exactly what gets hidden.
                </p>
              </>
            ) : (
              <>
                <div className="rv-empty-badge" aria-hidden>
                  ✓
                </div>
                <h2>All caught up</h2>
                <p className="rv-muted">
                  {done > 0 ? `You reviewed ${done} card${done === 1 ? '' : 's'} this session. ` : ''}
                  {queue.nextDue !== null ? (
                    <>
                      Next card <strong>{formatWhen(queue.nextDue, now)}</strong>.
                    </>
                  ) : (
                    'Nothing else is scheduled.'
                  )}
                </p>
                <div className="rv-stats">
                  <div className="rv-stat">
                    <Flame size={16} aria-hidden />
                    <span className="rv-stat-n">{s.streak}</span>
                    <span className="rv-stat-label">day streak</span>
                  </div>
                  <div className="rv-stat">
                    <span className="rv-stat-n">{s.retention === null ? '—' : `${Math.round(s.retention * 100)}%`}</span>
                    <span className="rv-stat-label">retention (30d)</span>
                  </div>
                  <div className="rv-stat">
                    <span className="rv-stat-n">{s.total}</span>
                    <span className="rv-stat-label">cards</span>
                  </div>
                </div>
                <div className="rv-forecast-wrap">
                  <div className="rv-forecast-title">
                    <CalendarClock size={14} aria-hidden /> Next 7 days
                  </div>
                  <Forecast counts={s.forecast} now={now} />
                </div>
              </>
            )}
          </section>
        </main>
      </div>
    );
  }

  const isCloze = current.kind === 'cloze' && current.clozeIndex !== undefined;
  const answerBlock = !isCloze && revealed ? renderBlock(current.pageId, current.blockId) : null;
  const showLeech = !!current.leech && dismissedLeech !== current.id;

  return (
    <div className="rv-root">
      {header}
      <main className="rv-main">
        {notice}
        {showLeech && (
          <LeechCallout
            vault={vault}
            card={current}
            onOpenAnchor={onOpenAnchor}
            onOpenPage={onOpenPage}
            onDismiss={() => setDismissedLeech(current.id)}
          />
        )}
        <article key={shownKey} className="rv-card rv-enter" aria-live="polite">
          <div className="rv-card-meta">
            <button type="button" className="rv-page-link" onClick={() => onOpenPage(current.pageId, current.blockId)} title="Open in note">
              {pageTitle}
              <ExternalLink size={12} aria-hidden />
            </button>
            {current.state !== 'review' && <span className={`rv-state rv-state-${current.state}`}>{current.state}</span>}
          </div>
          <div className="rv-card-body">
            {isCloze ? (
              <Markdown className="rv-md" source={renderCloze(current.front, current.clozeIndex!, revealed)} />
            ) : (
              <>
                <Markdown className="rv-md" source={current.front} />
                {revealed && (
                  <div className="rv-answer rv-reveal">
                    <hr className="rv-divider" />
                    {answerBlock ?? (current.back ? <Markdown className="rv-md" source={current.back} /> : null)}
                  </div>
                )}
              </>
            )}
          </div>
        </article>
      </main>
      <footer className="rv-footer">
        {!revealed ? (
          <button type="button" className="rv-btn rv-btn-primary rv-show" onClick={reveal}>
            Show answer <kbd className="rv-kbd">Space</kbd>
          </button>
        ) : (
          <div className="rv-ratings rv-reveal" role="group" aria-label="How well did you remember?">
            {RATINGS.map((r) => (
              <button key={r} type="button" className={`rv-rate rv-rate-${RATING_UI[r].tone}`} onClick={() => rate(r)}>
                <span className="rv-rate-ivl">{previews?.[r].intervalLabel}</span>
                <span className="rv-rate-label">{RATING_UI[r].label}</span>
                <kbd className="rv-kbd rv-rate-key">{r}</kbd>
              </button>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}
