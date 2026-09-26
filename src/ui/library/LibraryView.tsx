import { memo, useMemo, useState } from 'react';
import { FileUp, MoreHorizontal, BookOpen, Presentation, Trash2, Copy, Download, Upload, FileText, Plus, X, RefreshCw } from 'lucide-react';
import { useServices } from '../app/services';
import { useYSelect } from '../hooks/useY';
import { useBlobUrl } from '../hooks/usePage';
import type { SourceMeta, ViewState } from '../../core/schema';
import { useUI } from '../app/store';
import { importFilesToLibrary, useImportProgress, confirmGhostTag, dismissGhostTag, refreshCitation } from './importer';
import { pickFile, downloadText } from '../util/download';
import { MenuButton, type MenuItem } from '../components/Menu';
import { createSeminarNotebook } from './seminar';
import { copyText } from '../desk/dragout';
import { exportLibraryBib, importBibIntoSources } from '../../core/citations/mendeley';
import { metaToBib, serializeBibtex } from '../../core/citations/bibtex';
import './library.css';

const ACCEPT = '.pdf,.epub,.pptx,application/pdf,application/epub+zip,application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** The Source Vault: every imported PDF, EPUB and PPTX with reading progress and tags. */
export function LibraryView() {
  const { vault } = useServices();
  const [q, setQ] = useState('');
  const progress = useImportProgress();
  const toast = useUI((s) => s.toast);
  const sourcesKey = useYSelect(vault.sources, (m) => JSON.stringify([...m.values()].map((x) => x.toJSON())), { deep: true });
  const sources = useMemo(() => (JSON.parse(sourcesKey ?? '[]') as SourceMeta[]).sort((a, b) => b.addedAt - a.addedAt), [sourcesKey]);
  const viewStates = useYSelect(vault.viewStates, (m) => m.toJSON() as Record<string, ViewState>);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return sources;
    return sources.filter((x) => `${x.title} ${x.bib?.authors?.join(' ') ?? ''} ${x.bib?.bibKey ?? ''} ${x.tags?.join(' ') ?? ''} ${x.bib?.year ?? ''}`.toLowerCase().includes(s));
  }, [sources, q]);

  const doImport = async () => {
    const files = await pickFile(ACCEPT, true);
    if (!files.length) return;
    const n = await importFilesToLibrary(files);
    if (n) toast({ message: `Imported ${n} document${n > 1 ? 's' : ''}`, kind: 'success' });
  };

  const libMenu: MenuItem[] = [
    {
      label: 'Export library as BibTeX',
      icon: <Download size={15} />,
      run: () => downloadText('axiom-library.bib', exportLibraryBib(vault.listSources()), 'application/x-bibtex'),
    },
    {
      label: 'Import BibTeX (Zotero/Mendeley)',
      icon: <Upload size={15} />,
      run: async () => {
        const [f] = await pickFile('.bib,text/x-bibtex');
        if (!f) return;
        const result = importBibIntoSources(await f.text(), vault.listSources());
        let n = 0;
        for (const u of result.updates) {
          vault.updateSource(u.sourceId, { bib: { ...vault.getSource(u.sourceId)?.bib, ...u.bib } });
          n++;
        }
        toast({ message: `Matched ${n} entr${n === 1 ? 'y' : 'ies'} from ${f.name}`, kind: 'success' });
      },
    },
  ];

  return (
    <div className="library">
      <div className="lib-head">
        <h1>Library</h1>
        <input className="ui-input lib-search" placeholder="Filter by title, author, tag, key…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter library" />
        <button className="ui-btn primary" onClick={doImport}>
          <FileUp size={15} /> Import
        </button>
        <MenuButton items={libMenu} title="Library options" align="end">
          <MoreHorizontal size={18} />
        </MenuButton>
      </div>
      {progress.active > 0 && (
        <div className="lib-importing" role="status">
          <div className="ui-spinner" /> Importing {progress.current ?? ''}… ({progress.done}/{progress.total})
        </div>
      )}
      {sources.length === 0 ? (
        <div className="lib-dropzone">
          <FileText size={34} />
          <h3>Your Source Vault is empty</h3>
          <p>
            Drop PDFs, EPUBs or PowerPoint decks anywhere, or import them.
            <br />
            Axiom extracts the table of contents, citation metadata and a BibTeX key automatically.
          </p>
          <button className="ui-btn primary" onClick={doImport}>
            <FileUp size={15} /> Import documents
          </button>
        </div>
      ) : (
        <div className="lib-grid">
          {filtered.map((s) => (
            <SourceCard key={s.id} s={s} vs={viewStates?.[s.id]} />
          ))}
        </div>
      )}
    </div>
  );
}

const SourceCard = memo(function SourceCard({ s, vs }: { s: SourceMeta; vs?: ViewState }) {
  const { vault } = useServices();
  const openReader = useUI((st) => st.openReader);
  const navigate = useUI((st) => st.navigate);
  const toast = useUI((st) => st.toast);
  const thumb = useBlobUrl(s.thumbBlobId);
  const progress = s.pageCount && vs?.loc.page ? Math.min(1, vs.loc.page / s.pageCount) : 0;
  const authors = s.bib?.authors?.length ? (s.bib.authors.length > 2 ? `${s.bib.authors[0]} et al.` : s.bib.authors.join(', ')) : '';

  const menu = (): MenuItem[] => [
    { label: 'Open', icon: <BookOpen size={15} />, run: () => openReader(s.id) },
    ...(s.isSlides || s.kind === 'pptx'
      ? [
          {
            label: 'Create seminar notebook',
            icon: <Presentation size={15} />,
            run: async () => navigate({ name: 'page', pageId: await createSeminarNotebook(s) }),
          },
        ]
      : []),
    {
      label: 'Copy BibTeX',
      icon: <Copy size={15} />,
      run: () => copyText(serializeBibtex([metaToBib(s.bib ?? { title: s.title })])).then(() => toast({ message: 'BibTeX copied' })),
    },
    { label: 'Refresh citation metadata', icon: <RefreshCw size={15} />, run: () => void refreshCitation(s.id).then((ok) => toast({ message: ok ? 'Citation updated' : 'No online metadata found' })) },
    { separator: true, label: '' },
    {
      label: 'Remove from library',
      icon: <Trash2 size={15} />,
      danger: true,
      run: () => {
        const snapshot = vault.getSource(s.id);
        vault.removeSource(s.id);
        toast({ message: `Removed “${s.title}”`, action: snapshot ? { label: 'Undo', run: () => vault.putSource(snapshot) } : undefined });
      },
    },
  ];

  return (
    <div className="lib-card" role="button" tabIndex={0} onClick={() => openReader(s.id)} onKeyDown={(e) => e.key === 'Enter' && openReader(s.id)} data-source-id={s.id}>
      <div className="lib-thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : s.kind === 'pptx' || s.isSlides ? <Presentation size={30} /> : <FileText size={30} />}
        <span className="lib-kind">{s.isSlides && s.kind === 'pdf' ? 'SLIDES' : s.kind.toUpperCase()}</span>
        {progress > 0 && <div className="lib-progress" style={{ width: `${progress * 100}%` }} />}
      </div>
      <div className="lib-meta">
        <div className="lib-title" title={s.title}>
          {s.title}
        </div>
        {(authors || s.bib?.year) && (
          <div className="lib-authors">
            {authors}
            {authors && s.bib?.year ? ' · ' : ''}
            {s.bib?.year}
          </div>
        )}
        <div className="lib-card-actions" onClick={(e) => e.stopPropagation()}>
          {s.bib?.bibKey && <span className="lib-key" style={{ marginRight: 'auto' }}>@{s.bib.bibKey}</span>}
          <MenuButton items={menu} title="Source options" align="end">
            <MoreHorizontal size={16} />
          </MenuButton>
        </div>
        {(s.tags?.length || s.ghostTags?.length) ? (
          <div className="lib-tags" onClick={(e) => e.stopPropagation()}>
            {s.tags?.map((t) => (
              <span key={t} className="ui-chip tag">
                #{t}
              </span>
            ))}
            {s.ghostTags
              ?.filter((t) => !s.tags?.includes(t) && !s.dismissedGhostTags?.includes(t))
              .slice(0, 5)
              .map((t) => (
                <span key={t} className="ui-chip ghost" title="Suggested tag — tap to confirm">
                  <button className="ghost-confirm" onClick={() => confirmGhostTag(s.id, t)} aria-label={`Confirm tag ${t}`}>
                    <Plus size={11} /> {t}
                  </button>
                  <button className="ghost-dismiss" onClick={() => dismissGhostTag(s.id, t)} aria-label={`Dismiss tag ${t}`}>
                    <X size={11} />
                  </button>
                </span>
              ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});
