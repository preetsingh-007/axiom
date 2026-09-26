import * as Y from 'yjs';
import type { Vault } from '../../core/vault';
import type { SyncManager } from '../../core/sync/manager';
import { loadSyncConfig, saveSyncConfig, createRelayTransport, createGitRemote, type SyncConfig } from '../../core/sync/config';
import { GitSync, type GitSyncStatus, type MarkdownFile } from '../../core/sync/git/gitsync';
import type { EncryptedTransport } from '../../core/sync/crypto';
import type { RelayTransport } from '../../core/sync/relay';
import { Emitter } from '../../core/util/emitter';
import { snapshotPage } from '../../core/blocks';
import { pageToMarkdown } from '../../core/export/markdown';
import type { TransportStatus } from '../../core/sync/protocol';

export interface SyncState {
  relay: TransportStatus | 'off';
  peers: number;
  rejected: number;
  git: GitSyncStatus | null;
  gitEnabled: boolean;
}

function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|#^[\]]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}

interface MirrorEntry {
  title: string;
  kind: string;
  /** null when the page has no content (skipped) */
  content: string | null;
}

/**
 * Human-readable Markdown mirror committed next to the CRDT logs. Incremental: only pages that
 * changed since the last export (or were renamed) are re-rendered.
 */
export class MarkdownMirror {
  private cache = new Map<string, MirrorEntry>();
  private dirty = new Set<string>();
  private off: () => void;

  constructor(private vault: Vault) {
    this.off = vault.store.onDocChanged.on(({ docId }) => this.dirty.add(docId));
  }

  destroy() {
    this.off();
  }

  async export(): Promise<MarkdownFile[]> {
    const vault = this.vault;
    const out: MarkdownFile[] = [];
    const used = new Set<string>();
    const live = new Set<string>();
    for (const p of vault.listPages()) {
      live.add(p.id);
      let entry = this.cache.get(p.id);
      if (!entry || this.dirty.has(p.id) || entry.title !== p.title || entry.kind !== p.kind) {
        entry = { title: p.title, kind: p.kind, content: await renderPage(vault, p.id, p.title) };
        this.cache.set(p.id, entry);
        this.dirty.delete(p.id);
      }
      if (entry.content === null) continue;
      const dir = p.kind === 'daily' ? 'daily' : p.kind === 'concept' ? 'concepts' : 'pages';
      let path = `${dir}/${safeName(p.title)}.md`;
      for (let i = 2; used.has(path.toLowerCase()); i++) path = `${dir}/${safeName(p.title)} (${i}).md`;
      used.add(path.toLowerCase());
      out.push({ path, content: entry.content });
    }
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);
    return out;
  }
}

async function renderPage(vault: Vault, pageId: string, title: string): Promise<string | null> {
  const state = await vault.store.getState(pageId);
  if (!state) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const blocks = snapshotPage(doc);
  doc.destroy();
  if (!blocks.some((b) => b.text.trim() || b.type !== 'text')) return null;
  return pageToMarkdown(title, blocks, { source: (id) => vault.getSource(id) });
}

/** One-shot full export (Settings → Export all). */
export function exportMarkdownMirror(vault: Vault): Promise<MarkdownFile[]> {
  const m = new MarkdownMirror(vault);
  return m.export().finally(() => m.destroy());
}

/**
 * Owns the network side of sync for a vault: the encrypted relay transport and background
 * Git persistence. Rebuilt whenever the (local-only) sync config changes.
 */
export class SyncController {
  readonly onChange = new Emitter<void>();
  cfg: SyncConfig = { relayEnabled: false };
  git: GitSync | null = null;
  relay: EncryptedTransport | null = null;
  private offs: (() => void)[] = [];
  private relayStatus: TransportStatus | 'off' = 'off';
  private mirror: MarkdownMirror;
  /** rebuilds are serialised: overlapping apply() calls must never leak a GitSync */
  private rebuildChain: Promise<void> = Promise.resolve();

  constructor(
    private vault: Vault,
    private sync: SyncManager,
    private deviceName: string,
  ) {
    this.mirror = new MarkdownMirror(vault);
    this.offs.push(
      sync.onStatus.on(({ transport, status }) => {
        if (transport === 'relay') {
          this.relayStatus = status;
          this.onChange.emit();
        }
      }),
      sync.onPeers.on(() => this.onChange.emit()),
    );
  }

  async init() {
    this.cfg = await loadSyncConfig(this.vault);
    await this.rebuild();
  }

  state(): SyncState {
    const inner = this.relay?.inner as RelayTransport | undefined;
    return {
      relay: this.relay ? this.relayStatus : 'off',
      peers: inner?.peerCount?.() ?? 0,
      rejected: this.relay?.rejectedFrames ?? 0,
      git: this.git?.status ?? null,
      gitEnabled: !!this.git,
    };
  }

  async apply(cfg: SyncConfig) {
    this.cfg = cfg;
    await saveSyncConfig(this.vault, cfg);
    await this.rebuild();
  }

  async syncNow() {
    await this.git?.sync();
    await this.sync.resync();
  }

  private rebuild(): Promise<void> {
    this.rebuildChain = this.rebuildChain.then(() => this.doRebuild()).catch((e) => console.warn('[axiom] sync rebuild failed', e));
    return this.rebuildChain;
  }

  private async doRebuild() {
    this.sync.remove('relay');
    this.relay = null;
    this.relayStatus = 'off';
    this.git?.destroy();
    this.git = null;

    const relay = await createRelayTransport(this.cfg);
    if (relay) {
      this.relay = relay;
      this.relayStatus = relay.status;
      relay.onRejected.on(() => this.onChange.emit());
      this.sync.add(relay);
    }
    const remote = createGitRemote(this.cfg.git);
    if (remote) {
      const vault = this.vault;
      const git = new GitSync({
        store: vault.store,
        remote,
        deviceName: this.deviceName,
        kv: { get: (k) => vault.getLocal(k), set: (k, v) => vault.setLocal(k, v) },
        blobs: this.cfg.git!.syncFiles
          ? { list: () => vault.db.listBlobIds(), get: (id) => vault.db.getBlob(id), put: (id, b) => vault.db.putBlob(id, b) }
          : undefined,
        exporters: () => this.mirror.export(),
      });
      git.onStatus.on(() => this.onChange.emit());
      git.start({ lockName: `axiom-git-${vault.name}` });
      this.git = git;
    }
    this.onChange.emit();
  }

  destroy() {
    this.offs.forEach((f) => f());
    this.mirror.destroy();
    this.git?.destroy();
    this.sync.remove('relay');
  }
}
