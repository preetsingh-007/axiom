import { useEffect, useState } from 'react';
import { RefreshCw, Check } from 'lucide-react';
import { useServices } from './services';
import { useUI } from './store';
import { loadZoteroConfig, saveZoteroConfig, syncZotero, type ZoteroConfig } from '../library/zoteroSync';

/** Zotero Web API credentials (local only) + two-way sync trigger. */
export function ZoteroSettings() {
  const { vault } = useServices();
  const toast = useUI((s) => s.toast);
  const [cfg, setCfg] = useState<ZoteroConfig>({ userId: '', apiKey: '' });
  const [saved, setSaved] = useState<ZoteroConfig | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadZoteroConfig(vault).then((c) => {
      setCfg(c);
      setSaved(c);
    });
  }, [vault]);

  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);

  return (
    <>
      <div className="set-grid">
        <label className="set-field">
          <span className="set-label">Zotero user ID</span>
          <input className="ui-input" inputMode="numeric" value={cfg.userId} onChange={(e) => setCfg({ ...cfg, userId: e.target.value.trim() })} />
          <span className="set-hint">
            Shown at{' '}
            <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noreferrer">
              zotero.org/settings/keys
            </a>
          </span>
        </label>
        <label className="set-field">
          <span className="set-label">API key (read/write)</span>
          <input className="ui-input" type="password" autoComplete="off" value={cfg.apiKey} onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value.trim() })} />
          <span className="set-hint">Stored on this device only.</span>
        </label>
      </div>
      {saved?.lastSyncedAt && <p className="set-hint">Last synced {new Date(saved.lastSyncedAt).toLocaleString()}</p>}
      <div className="set-actions">
        <button
          className="ui-btn primary"
          disabled={!dirty}
          onClick={async () => {
            await saveZoteroConfig(vault, cfg);
            setSaved(cfg);
            toast({ message: 'Zotero settings saved', kind: 'success' });
          }}
        >
          <Check size={14} /> Save
        </button>
        <button
          className="ui-btn"
          disabled={busy || !saved?.userId || !saved?.apiKey}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await syncZotero(vault);
              const next = await loadZoteroConfig(vault);
              setSaved(next);
              setCfg(next);
              toast({ message: `Zotero: ${r.updatedLocal} updated here, ${r.createdRemote} added to Zotero`, kind: 'success' });
            } catch (e) {
              toast({ message: `Zotero sync failed: ${(e as Error).message ?? e}`, kind: 'error' });
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={14} className={busy ? 'spin' : ''} /> Sync with Zotero
        </button>
      </div>
    </>
  );
}
