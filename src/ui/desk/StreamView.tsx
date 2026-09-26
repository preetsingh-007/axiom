import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useServices } from '../app/services';
import { useYSelect } from '../hooks/useY';
import { usePageDoc } from '../hooks/usePage';
import { BlockList } from './BlockList';
import { addDays, formatDateLong, isoDate } from '../../core/util/ids';
import { useUI } from '../app/store';
import { useGraphVersion } from '../app/graphHooks';
import type { AppServices } from '../app/bootstrap';

const heightCache = new Map<string, number>();

/**
 * The Daily Stream: an infinite, time-stamped canvas. Today on top, earlier days below,
 * each day's page loaded only when it scrolls near the viewport.
 */
export function StreamView() {
  const { vault } = useServices();
  const [today, setToday] = useState(isoDate());
  const graphVersion = useGraphVersion();

  // roll over at midnight
  useEffect(() => {
    const t = setInterval(() => setToday(isoDate()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    vault.ensureDaily(today);
  }, [vault, today]);

  const dailyKey = useYSelect(vault.pages, (pages) => {
    const out: string[] = [];
    for (const m of pages.values()) if (m.get('kind') === 'daily' && !m.get('trashed')) out.push(`${m.get('date')}|${m.get('id')}`);
    return out.sort().reverse().join(',');
  });

  const { isEmptyPage } = useServices() as AppServices;
  const days = useMemo(() => {
    const list = (dailyKey ?? '')
      .split(',')
      .filter(Boolean)
      .map((s) => {
        const [date, id] = s.split('|');
        return { date, id };
      })
      .filter((d) => d.date <= today);
    // hide past days that have no content (you visited but didn't write)
    return list.filter((d) => d.date === today || !isEmptyPage(d.id));
    // graphVersion: re-filter when the index learns about content
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyKey, today, isEmptyPage, graphVersion]);

  return (
    <div className="stream">
      {days.map((d, i) => (
        <DaySection key={d.id} pageId={d.id} date={d.date} isToday={d.date === today} eager={i < 2} yesterday={addDays(today, -1) === d.date} />
      ))}
      {days.length <= 1 && (
        <p className="stream-hint">
          Everything you capture lands here, stamped with time. Link ideas with <code>[[Concept]]</code>, tag with <code>#tag</code>, add <code>#flashcard</code> to review later, or spread two fingers between
          paragraphs to open whiteboard space.
        </p>
      )}
    </div>
  );
}

const DaySection = memo(function DaySection({ pageId, date, isToday, eager, yesterday }: { pageId: string; date: string; isToday: boolean; eager: boolean; yesterday: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(eager);
  const navigate = useUI((s) => s.navigate);

  useEffect(() => {
    if (visible || !ref.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '800px 0px' },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return () => {
      heightCache.set(pageId, el.offsetHeight);
    };
  }, [pageId]);

  return (
    <section ref={ref} className={`day${isToday ? ' day-today' : ''}`} style={visible ? undefined : { minHeight: heightCache.get(pageId) ?? 220 }} data-date={date}>
      <header className="day-head">
        <button className="day-title" onClick={() => navigate({ name: 'page', pageId })} title="Open this day as a page">
          {isToday ? 'Today' : yesterday ? 'Yesterday' : formatDateLong(date).split(',')[0]}
        </button>
        <span className="day-date">{formatDateLong(date)}</span>
      </header>
      {visible && <DayBody pageId={pageId} />}
    </section>
  );
});

function DayBody({ pageId }: { pageId: string }) {
  const { vault } = useServices();
  const doc = usePageDoc(pageId);
  useEffect(() => {
    if (doc) vault.ensureNonEmpty(doc);
  }, [doc, vault]);
  if (!doc) return <div className="page-loading" />;
  return <BlockList doc={doc} pageId={pageId} showTime />;
}
