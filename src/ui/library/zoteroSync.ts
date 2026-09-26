import type { Vault } from '../../core/vault';
import { ZoteroClient, syncZotero as runZoteroSync, emptyZoteroState, type ZoteroSyncState } from '../../core/citations/zotero';
import { makeCiteKey } from '../../core/citations/citekey';

/** Local-only Zotero credentials and sync cursor. */
export interface ZoteroConfig {
  userId: string;
  apiKey: string;
  lastSyncedAt?: number;
}

const CFG_KEY = 'zotero-config';
const STATE_KEY = 'zotero-state';

export async function loadZoteroConfig(vault: Vault): Promise<ZoteroConfig> {
  return (await vault.getLocal<ZoteroConfig>(CFG_KEY)) ?? { userId: '', apiKey: '' };
}

export async function saveZoteroConfig(vault: Vault, cfg: ZoteroConfig): Promise<void> {
  const prev = await loadZoteroConfig(vault);
  // switching accounts invalidates the incremental cursor
  if (prev.userId && prev.userId !== cfg.userId) await vault.setLocal(STATE_KEY, emptyZoteroState());
  await vault.setLocal(CFG_KEY, cfg);
}

/** Two-way sync of the Library's citation metadata with Zotero. */
export async function syncZotero(vault: Vault): Promise<{ updatedLocal: number; createdRemote: number; errors: string[] }> {
  const cfg = await loadZoteroConfig(vault);
  if (!cfg.userId || !cfg.apiKey) throw new Error('Add your Zotero user ID and API key first');
  const client = new ZoteroClient({ userId: cfg.userId, apiKey: cfg.apiKey });
  const state = (await vault.getLocal<ZoteroSyncState>(STATE_KEY)) ?? emptyZoteroState();
  const sources = vault.listSources().map((s) => ({ id: s.id, bib: s.bib, title: s.title }));
  let updatedLocal = 0;
  const result = await runZoteroSync(client, sources, state, {
    applyLocal: (updates) => {
      for (const u of updates) {
        const cur = vault.getSource(u.sourceId);
        if (!cur) continue;
        const others = vault.listSources().filter((s) => s.id !== u.sourceId).map((s) => s.bib?.bibKey).filter((k): k is string => !!k);
        const bib = { ...cur.bib, ...u.bib };
        bib.bibKey = cur.bib?.bibKey ?? makeCiteKey(bib, others);
        vault.updateSource(u.sourceId, { bib });
        updatedLocal++;
      }
    },
  });
  await vault.setLocal(STATE_KEY, result.state);
  await vault.setLocal(CFG_KEY, { ...cfg, lastSyncedAt: Date.now() });
  return { updatedLocal, createdRemote: result.created, errors: result.errors };
}
