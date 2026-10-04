import { Vault } from '../../core/vault';
import { SyncManager } from '../../core/sync/manager';
import { BroadcastTransport } from '../../core/sync/broadcast';
import { GraphIndex } from '../../core/graph/index';
import { AIRouter, loadAIConfig, hasModelProvider } from '../../core/ai';
import type { AIConfig } from '../../core/ai/types';
import { syncCards } from '../../core/srs';
import { uid } from '../../core/util/ids';
import { debounce, serialized } from '../../core/util/emitter';
import { SyncController } from './syncController';
import { seedWelcome } from './welcome';
import type { Services } from './services';
import { setServicesRef } from './servicesRef';
import { startMaintenance } from './maintenance';
import { useUI } from './store';
import { parseSyncCode, applyJoinInfo, loadSyncConfig, saveSyncConfig } from '../../core/sync/config';
import * as blocksModule from '../../core/blocks';

export interface AppServices extends Services {
  graph: GraphIndex;
  ai: AIRouter;
  aiConfig: { current: AIConfig };
  syncController: SyncController;
  /** true when a page has no meaningful content (hide empty past days in the stream) */
  isEmptyPage(pageId: string): boolean;
}

function deviceInfo(): { id: string; name: string } {
  let id = '';
  try {
    id = localStorage.getItem('axiom-device') ?? '';
    if (!id) {
      id = uid(10);
      localStorage.setItem('axiom-device', id);
    }
  } catch {
    id = uid(10);
  }
  const ua = navigator.userAgent;
  const name = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  // per-tab suffix: tabs on one device are distinct peers on the BroadcastChannel
  return { id: `${id}:${uid(4)}`, name };
}

/** Opens the vault and starts every background service. */
export async function bootstrap(): Promise<AppServices> {
  const params = new URLSearchParams(location.search);
  const vaultName = params.get('vault') ?? 'axiom-default';
  const vault = await Vault.open(vaultName);
  const device = deviceInfo();

  const sync = new SyncManager(vault.store, device);
  sync.add(new BroadcastTransport(`axiom-sync-${vault.name}`));

  const aiConfig = { current: await loadAIConfig(vault) };
  const ai = new AIRouter(() => aiConfig.current);

  const graph = new GraphIndex(vault);
  const syncController = new SyncController(vault, sync, device.name);

  const services: AppServices = {
    vault,
    sync,
    device,
    graph,
    ai,
    aiConfig,
    syncController,
    isEmptyPage: (pageId) => {
      if (!graph.hasPage(pageId)) return false;
      return graph.pageBlocks(pageId).every((b) => b.type === 'text' && !b.text.trim());
    },
  };
  setServicesRef(services);

  // "#join=AXJ1…" links configure sync on a new device in one step
  const joinMatch = /[#&]join=([^&]+)/.exec(location.hash);
  const existingSync = await loadSyncConfig(vault);
  const joining = !!joinMatch || !!existingSync.secret || !!existingSync.git?.enabled;
  if (joinMatch) {
    const info = parseSyncCode(decodeURIComponent(joinMatch[1]));
    history.replaceState(null, '', location.pathname + location.search + '#/stream');
    if (info) {
      await saveSyncConfig(vault, applyJoinInfo(await loadSyncConfig(vault), info));
    }
  }

  await seedWelcome(vault, { joining });
  await syncController.init().catch((e) => console.warn('[axiom] sync init failed', e));

  // Index in the background; the UI renders immediately and refines as the index fills.
  const indexReady = graph.init().catch((e) => console.error('[axiom] index init failed', e));

  // Flashcards follow #flashcard tags on Desk pages. With a model provider set up, the AI writes
  // the cloze deletions (falling back to heuristics on any failure); runs never overlap.
  void indexReady.then(() => {
    const refreshCards = serialized(async () => {
      try {
        const sources = await graph.flashcardBlocks();
        await syncCards(vault, sources, hasModelProvider(aiConfig.current) ? { ai } : {});
      } catch (e) {
        console.warn('[axiom] card sync failed', e);
      }
    });
    // wait for a longer pause when each run may call the network
    const schedule = debounce(() => refreshCards(), 800);
    const scheduleAI = debounce(() => refreshCards(), 2500);
    refreshCards();
    graph.onChange.on(() => (hasModelProvider(aiConfig.current) ? scheduleAI() : schedule()));
  });

  startMaintenance(services);

  let lastStorageWarning = 0;
  vault.store.onError.on((e) => {
    if (Date.now() - lastStorageWarning < 60_000) return;
    lastStorageWarning = Date.now();
    const quota = /quota/i.test(e.name + e.message);
    useUI.getState().toast({
      message: quota ? 'Browser storage is full — changes are kept in memory and retried. Free space or back up to Git.' : `Saving failed (${e.message}); retrying…`,
      kind: 'error',
      timeout: 8000,
    });
  });

  if (import.meta.env.DEV || params.has('debug')) {
    (window as unknown as { axiom: unknown }).axiom = Object.assign(services, { __blocks: blocksModule });
  }
  return services;
}
