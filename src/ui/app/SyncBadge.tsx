import { useEffect, useReducer } from 'react';
import { Cloud, CloudOff, HardDrive, RefreshCw, AlertTriangle } from 'lucide-react';
import { useServices } from './services';
import type { AppServices } from './bootstrap';
import { useUI } from './store';

function ago(ts?: number) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Compact sync status in the sidebar footer. */
export function SyncBadge() {
  const { syncController } = useServices() as AppServices;
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const navigate = useUI((s) => s.navigate);
  useEffect(() => {
    const off = syncController.onChange.on(bump);
    const t = setInterval(bump, 30_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [syncController]);
  const st = syncController.state();
  let icon = <HardDrive size={15} />;
  let label = 'On this device';
  let tone = '';
  if (st.git?.state === 'pulling' || st.git?.state === 'pushing') {
    icon = <RefreshCw size={15} className="spin" />;
    label = 'Syncing…';
  } else if (st.git?.state === 'error' || st.rejected > 0) {
    icon = <AlertTriangle size={15} />;
    label = st.rejected > 0 ? 'Sync key mismatch' : 'Sync error';
    tone = 'warn';
  } else if (st.git?.state === 'offline' || st.relay === 'error') {
    icon = <CloudOff size={15} />;
    label = 'Offline — saved locally';
  } else if (st.relay === 'open' || st.gitEnabled) {
    icon = <Cloud size={15} />;
    const parts: string[] = [];
    if (st.relay === 'open') parts.push(st.peers ? `${st.peers + 1} devices live` : 'Live');
    if (st.git?.lastSyncedAt) parts.push(`Git ${ago(st.git.lastSyncedAt)}`);
    label = parts.join(' · ') || 'Sync on';
    tone = 'ok';
  }
  return (
    <button className={`sync-badge ${tone}`} onClick={() => navigate({ name: 'settings', section: 'sync' })} title={st.git?.lastError ?? 'Sync settings'}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
