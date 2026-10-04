import { useEffect, useReducer, useState, type ReactNode } from 'react';
import { RefreshCw, Copy, KeyRound, Link2, Cloud, Sparkles, Palette, Database, BookMarked, Layers, Download, Check, AlertTriangle, Zap } from 'lucide-react';
import { useServices } from './services';
import type { AppServices } from './bootstrap';
import { useUI, type Theme } from './store';
import { generateSyncSecret } from '../../core/sync/crypto';
import { buildSyncCode, buildJoinUrl, parseSyncCode, applyJoinInfo, type SyncConfig, type GitConfig } from '../../core/sync/config';
import { copyText } from '../desk/dragout';
import { ALL_PROVIDERS, saveAIConfig, hasWebGPU, OPENAI_PRESETS, DEFAULT_GEMINI_MODEL, DEFAULT_ANTHROPIC_MODEL, DEFAULT_WEBLLM_MODEL, probeProviders, PROBE_PROVIDERS, type ProbeResult } from '../../core/ai';
import type { AIConfig, ProviderId } from '../../core/ai/types';
import { ZoteroSettings } from './ZoteroSettings';
import { exportMarkdownMirror } from './syncController';
import { downloadBlob } from '../util/download';
import './settings.css';

function Section({ id, icon, title, desc, children }: { id: string; icon: ReactNode; title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="set-section" id={`settings-${id}`}>
      <header className="set-head">
        <span className="set-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          {desc && <p>{desc}</p>}
        </div>
      </header>
      <div className="set-body">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="set-field">
      <span className="set-label">{label}</span>
      {children}
      {hint && <span className="set-hint">{hint}</span>}
    </label>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <label className="set-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="set-switch" aria-hidden />
      <span>{label}</span>
    </label>
  );
}

export function Settings({ section }: { section?: string }) {
  useEffect(() => {
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' });
  }, [section]);
  return (
    <div className="settings">
      <h1 className="set-title">Settings</h1>
      <SyncSettings />
      <AISettings />
      <ReviewSettings />
      <Section id="citations" icon={<BookMarked size={18} />} title="Citations" desc="Two-way sync with Zotero. For Mendeley (or Zotero Better BibTeX), import/export .bib files from the Library menu.">
        <ZoteroSettings />
      </Section>
      <AppearanceSettings />
      <DataSettings />
    </div>
  );
}

// ---------------- Sync ----------------

function SyncSettings() {
  const { syncController, device } = useServices() as AppServices;
  const toast = useUI((s) => s.toast);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => syncController.onChange.on(bump), [syncController]);
  const [cfg, setCfg] = useState<SyncConfig>(() => structuredClone(syncController.cfg));
  const [join, setJoin] = useState('');
  const st = syncController.state();
  const dirty = JSON.stringify(cfg) !== JSON.stringify(syncController.cfg);
  const git: GitConfig = cfg.git ?? { provider: 'github', token: '', repo: '', branch: 'main', syncFiles: true, enabled: false };
  const setGit = (patch: Partial<GitConfig>) => setCfg({ ...cfg, git: { ...git, ...patch } });

  const save = async () => {
    await syncController.apply(cfg);
    toast({ message: 'Sync settings saved', kind: 'success' });
  };

  const code = cfg.secret ? buildSyncCode(cfg) : '';

  return (
    <Section id="sync" icon={<Cloud size={18} />} title="Sync & backup" desc="Your notes live on this device. Link devices for real-time, end-to-end encrypted sync, and back up to your own Git repository.">
      <div className="set-status">
        <span className={`set-dot ${st.relay === 'open' ? 'ok' : st.relay === 'off' ? '' : 'warn'}`} /> Live sync: {st.relay === 'off' ? 'off' : st.relay}
        {st.relay === 'open' && ` · ${st.peers} other device${st.peers === 1 ? '' : 's'} online`}
        <span className="set-sep" />
        <span className={`set-dot ${st.git?.state === 'idle' ? 'ok' : st.git?.state === 'error' ? 'bad' : st.git ? 'warn' : ''}`} /> Git: {st.git ? st.git.state : 'off'}
        {st.git?.lastSyncedAt && ` · ${new Date(st.git.lastSyncedAt).toLocaleTimeString()}`}
        <span className="set-grow" />
        <span className="set-device">This device: {device.name}</span>
      </div>
      {st.rejected > 0 && (
        <div className="set-warn">
          <AlertTriangle size={15} /> A device with a different sync key is in this relay room. Make sure all devices use the same join code.
        </div>
      )}
      {st.git?.lastError && (
        <div className="set-warn">
          <AlertTriangle size={15} /> {st.git.lastError}
        </div>
      )}

      <h3 className="set-sub">
        <KeyRound size={15} /> Link devices
      </h3>
      {cfg.secret ? (
        <div className="set-code">
          <code>{code}</code>
          <button className="ui-btn small" onClick={() => copyText(code).then(() => toast({ message: 'Join code copied' }))}>
            <Copy size={13} /> Copy code
          </button>
          <button className="ui-btn small ghost" onClick={() => copyText(buildJoinUrl(cfg, location.origin + location.pathname)).then(() => toast({ message: 'Join link copied' }))}>
            <Link2 size={13} /> Copy link
          </button>
        </div>
      ) : (
        <button className="ui-btn" onClick={() => setCfg({ ...cfg, secret: generateSyncSecret(), relayEnabled: !!cfg.relayUrl || cfg.relayEnabled })}>
          <KeyRound size={14} /> Create a sync key
        </button>
      )}
      <div className="set-row">
        <input className="ui-input" placeholder="…or paste a join code from another device" value={join} onChange={(e) => setJoin(e.target.value)} />
        <button
          className="ui-btn"
          disabled={!join.trim()}
          onClick={() => {
            const info = parseSyncCode(join);
            if (!info) return toast({ message: 'That join code is not valid', kind: 'error' });
            setCfg(applyJoinInfo(cfg, info));
            setJoin('');
            toast({ message: 'Join code applied — review and save' });
          }}
        >
          Join
        </button>
      </div>
      <Field label="Relay server" hint="A tiny stateless relay forwards encrypted updates between your devices; it cannot read them. Run your own for free (see server/README.md).">
        <input className="ui-input" placeholder="wss://relay.example.com" value={cfg.relayUrl ?? ''} onChange={(e) => setCfg({ ...cfg, relayUrl: e.target.value.trim() || undefined })} />
      </Field>
      <Toggle checked={cfg.relayEnabled} onChange={(v) => setCfg({ ...cfg, relayEnabled: v })} label="Real-time sync through the relay" />

      <h3 className="set-sub">
        <Database size={15} /> Git backup
      </h3>
      <div className="set-grid">
        <Field label="Provider">
          <select className="ui-input" value={git.provider} onChange={(e) => setGit({ provider: e.target.value as GitConfig['provider'] })}>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </Field>
        <Field label="Repository" hint={git.provider === 'github' ? 'owner/name — created (private) if missing' : 'group/project'}>
          <input className="ui-input" placeholder="you/axiom-vault" value={git.repo} onChange={(e) => setGit({ repo: e.target.value.trim() })} />
        </Field>
        <Field label="Branch">
          <input className="ui-input" value={git.branch} onChange={(e) => setGit({ branch: e.target.value.trim() || 'main' })} />
        </Field>
        <Field label="Personal access token" hint={git.provider === 'github' ? 'Needs “repo” (classic) or Contents read/write (fine-grained). Stored on this device only.' : 'Needs the “api” scope. Stored on this device only.'}>
          <input className="ui-input" type="password" autoComplete="off" value={git.token} onChange={(e) => setGit({ token: e.target.value.trim() })} />
        </Field>
        <Field label="API base URL (optional)" hint="GitHub Enterprise or self-hosted GitLab">
          <input className="ui-input" placeholder={git.provider === 'github' ? 'https://api.github.com' : 'https://gitlab.com'} value={git.baseUrl ?? ''} onChange={(e) => setGit({ baseUrl: e.target.value.trim() || undefined })} />
        </Field>
      </div>
      <Toggle checked={git.enabled} onChange={(v) => setGit({ enabled: v })} label="Commit changes to Git in the background" />
      <Toggle checked={git.syncFiles} onChange={(v) => setGit({ syncFiles: v })} label="Also back up source files (PDFs, EPUBs, images; up to 50 MB each)" />

      <div className="set-actions">
        <button className="ui-btn primary" disabled={!dirty} onClick={save}>
          <Check size={14} /> Save
        </button>
        <button className="ui-btn" disabled={!st.gitEnabled && st.relay === 'off'} onClick={() => syncController.syncNow().then(() => toast({ message: 'Synced' }), (e) => toast({ message: String(e?.message ?? e), kind: 'error' }))}>
          <RefreshCw size={14} /> Sync now
        </button>
      </div>
    </Section>
  );
}

// ---------------- AI ----------------

const PROVIDER_LABEL: Record<ProviderId, string> = {
  gemini: 'Google AI Studio (Gemini, free tier)',
  anthropic: 'Anthropic API key',
  openai: 'OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio)',
  webllm: 'On-device model (WebGPU, offline)',
  bridge: 'Subscription bridge (ChatGPT / Claude web, copy & paste)',
  local: 'Built-in heuristics (always on, offline)',
};

function AISettings() {
  const services = useServices() as AppServices;
  const toast = useUI((s) => s.toast);
  const [cfg, setCfg] = useState<AIConfig>(() => structuredClone(services.aiConfig.current));
  const dirty = JSON.stringify(cfg) !== JSON.stringify(services.aiConfig.current);
  const move = (id: ProviderId, dir: -1 | 1) => {
    const order = [...cfg.order];
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    setCfg({ ...cfg, order });
  };
  const save = async () => {
    await saveAIConfig(services.vault, cfg);
    services.aiConfig.current = cfg;
    toast({ message: 'AI settings saved', kind: 'success' });
  };
  const order = [...cfg.order, ...ALL_PROVIDERS.filter((p) => !cfg.order.includes(p))];
  const [probe, setProbe] = useState<ProbeResult[] | 'running' | null>(null);
  const testable = PROBE_PROVIDERS.some((id) => (id === 'openai' ? cfg.openai?.baseUrl && cfg.openai.model : cfg[id]?.apiKey?.trim()));
  const test = async () => {
    setProbe('running');
    const res = await probeProviders(cfg).catch((e) => [{ provider: 'gemini' as const, label: 'AI', ok: false, ms: 0, detail: String(e?.message ?? e) }]);
    setProbe(res);
  };
  return (
    <Section id="ai" icon={<Sparkles size={18} />} title="AI (zero cost)" desc="Handwriting & math recognition, ghost tags and cloze cards. Axiom tries providers in this order and falls back to built-in heuristics. Keys never leave this device except to call the provider you chose.">
      <ol className="set-providers">
        {order.map((id, i) => (
          <li key={id}>
            <span className="set-prov-rank">{i + 1}</span>
            <span className="set-prov-name">{PROVIDER_LABEL[id]}</span>
            <span className="set-prov-move">
              <button className="ui-icon-btn" aria-label="Move up" onClick={() => move(id, -1)} disabled={i === 0}>
                ↑
              </button>
              <button className="ui-icon-btn" aria-label="Move down" onClick={() => move(id, 1)} disabled={i === order.length - 1}>
                ↓
              </button>
            </span>
          </li>
        ))}
      </ol>
      <div className="set-grid">
        <Field label="Gemini API key" hint={<a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Get a free key</a>}>
          <input className="ui-input" type="password" autoComplete="off" value={cfg.gemini?.apiKey ?? ''} onChange={(e) => setCfg({ ...cfg, gemini: { model: cfg.gemini?.model || DEFAULT_GEMINI_MODEL, apiKey: e.target.value.trim() } })} />
        </Field>
        <Field label="Gemini model">
          <input className="ui-input" value={cfg.gemini?.model ?? DEFAULT_GEMINI_MODEL} onChange={(e) => setCfg({ ...cfg, gemini: { apiKey: cfg.gemini?.apiKey ?? '', model: e.target.value.trim() } })} />
        </Field>
        <Field label="Anthropic API key">
          <input className="ui-input" type="password" autoComplete="off" value={cfg.anthropic?.apiKey ?? ''} onChange={(e) => setCfg({ ...cfg, anthropic: { model: cfg.anthropic?.model || DEFAULT_ANTHROPIC_MODEL, apiKey: e.target.value.trim() } })} />
        </Field>
        <Field label="Anthropic model">
          <input className="ui-input" value={cfg.anthropic?.model ?? DEFAULT_ANTHROPIC_MODEL} onChange={(e) => setCfg({ ...cfg, anthropic: { apiKey: cfg.anthropic?.apiKey ?? '', model: e.target.value.trim() } })} />
        </Field>
        <Field label="OpenAI-compatible endpoint">
          <select
            className="ui-input"
            value={Object.entries(OPENAI_PRESETS).find(([, p]) => p.baseUrl === cfg.openai?.baseUrl)?.[0] ?? 'custom'}
            onChange={(e) => {
              const preset = (OPENAI_PRESETS as Record<string, { baseUrl: string; model: string }>)[e.target.value];
              if (preset) setCfg({ ...cfg, openai: { apiKey: cfg.openai?.apiKey, baseUrl: preset.baseUrl, model: preset.model } });
            }}
          >
            {Object.keys(OPENAI_PRESETS).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
            <option value="custom">custom</option>
          </select>
        </Field>
        <Field label="Base URL">
          <input className="ui-input" value={cfg.openai?.baseUrl ?? ''} placeholder="https://api.openai.com/v1" onChange={(e) => setCfg({ ...cfg, openai: { model: cfg.openai?.model ?? '', apiKey: cfg.openai?.apiKey, baseUrl: e.target.value.trim() } })} />
        </Field>
        <Field label="API key (optional for Ollama)">
          <input className="ui-input" type="password" autoComplete="off" value={cfg.openai?.apiKey ?? ''} onChange={(e) => setCfg({ ...cfg, openai: { model: cfg.openai?.model ?? '', baseUrl: cfg.openai?.baseUrl ?? '', apiKey: e.target.value.trim() || undefined } })} />
        </Field>
        <Field label="Model">
          <input className="ui-input" value={cfg.openai?.model ?? ''} onChange={(e) => setCfg({ ...cfg, openai: { baseUrl: cfg.openai?.baseUrl ?? '', apiKey: cfg.openai?.apiKey, model: e.target.value.trim() } })} />
        </Field>
      </div>
      <Toggle
        checked={!!cfg.webllm?.enabled}
        onChange={(v) => setCfg({ ...cfg, webllm: { model: cfg.webllm?.model || DEFAULT_WEBLLM_MODEL, enabled: v } })}
        label={`On-device model via WebGPU${hasWebGPU() ? '' : ' (WebGPU not available in this browser)'} — downloads ~1 GB once, then works offline`}
      />
      <div className="set-row">
        <Toggle checked={!!cfg.bridge?.enabled} onChange={(v) => setCfg({ ...cfg, bridge: { target: cfg.bridge?.target ?? 'claude', enabled: v } })} label="Subscription bridge using my" />
        <select className="ui-input set-inline" value={cfg.bridge?.target ?? 'claude'} onChange={(e) => setCfg({ ...cfg, bridge: { enabled: cfg.bridge?.enabled ?? false, target: e.target.value as 'claude' | 'chatgpt' } })}>
          <option value="claude">Claude</option>
          <option value="chatgpt">ChatGPT</option>
        </select>
        <span className="set-hint">account (copies the prompt, you paste the answer back)</span>
      </div>
      <div className="set-actions">
        <button className="ui-btn primary" disabled={!dirty} onClick={save}>
          <Check size={14} /> Save
        </button>
        <button className="ui-btn" disabled={!testable || probe === 'running'} onClick={test} title={testable ? 'Send a tiny request to each configured provider' : 'Add a key or endpoint first'}>
          <Zap size={14} /> {probe === 'running' ? 'Testing…' : 'Test'}
        </button>
      </div>
      {Array.isArray(probe) && (
        <ul className="set-probe" aria-live="polite">
          {probe.map((r) => (
            <li key={r.provider} className={r.ok ? 'ok' : 'bad'}>
              <span className={`set-dot ${r.ok ? 'ok' : 'bad'}`} />
              <b>{r.label}</b>
              {r.ok ? ` responded in ${(r.ms / 1000).toFixed(1)} s` : ` failed: ${r.detail}`}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------- Review ----------------

function ReviewSettings() {
  const { vault } = useServices();
  const get = (k: string, d: number) => (vault.settings.get(k) as number | undefined) ?? d;
  const [newPerDay, setNew] = useState(get('srs.newPerDay', 20));
  const [retention, setRet] = useState(get('srs.retention', 0.9));
  const [leech, setLeech] = useState(get('srs.leechThreshold', 4));
  const save = (k: string, v: number) => vault.transact(() => vault.settings.set(k, v));
  return (
    <Section id="review" icon={<Layers size={18} />} title="Spaced repetition" desc="FSRS scheduling. These settings sync across your devices.">
      <div className="set-grid">
        <Field label="New cards per day">
          <input className="ui-input" type="number" min={0} max={500} value={newPerDay} onChange={(e) => setNew(Number(e.target.value))} onBlur={() => save('srs.newPerDay', newPerDay)} />
        </Field>
        <Field label="Desired retention" hint="Higher = more reviews, better recall">
          <input className="ui-input" type="number" min={0.7} max={0.99} step={0.01} value={retention} onChange={(e) => setRet(Number(e.target.value))} onBlur={() => save('srs.retention', retention)} />
        </Field>
        <Field label="Leech after N lapses" hint="Leeches surface their Wormhole anchor so you can re-read the source">
          <input className="ui-input" type="number" min={2} max={20} value={leech} onChange={(e) => setLeech(Number(e.target.value))} onBlur={() => save('srs.leechThreshold', leech)} />
        </Field>
      </div>
    </Section>
  );
}

// ---------------- Appearance ----------------

function AppearanceSettings() {
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  return (
    <Section id="appearance" icon={<Palette size={18} />} title="Appearance">
      <div className="set-seg" role="radiogroup" aria-label="Theme">
        {(['system', 'light', 'dark'] as Theme[]).map((t) => (
          <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
    </Section>
  );
}

// ---------------- Data ----------------

function DataSettings() {
  const { vault } = useServices();
  const toast = useUI((s) => s.toast);
  const [usage, setUsage] = useState<string>('');
  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => {
      if (e.usage !== undefined) setUsage(`${(e.usage / 1024 / 1024).toFixed(1)} MB used${e.quota ? ` of ${(e.quota / 1024 / 1024 / 1024).toFixed(1)} GB available` : ''}`);
    });
  }, []);
  const exportAll = async () => {
    const files = await exportMarkdownMirror(vault);
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    for (const f of files) zip.file(f.path, f.content);
    downloadBlob(`axiom-export-${new Date().toISOString().slice(0, 10)}.zip`, await zip.generateAsync({ type: 'blob' }));
    toast({ message: `Exported ${files.length} pages` });
  };
  return (
    <Section id="data" icon={<Database size={18} />} title="Your data" desc="Everything is stored locally in your browser (IndexedDB) and works offline.">
      <p className="set-hint">
        {vault.pages.size} pages · {vault.sources.size} sources · {vault.cards.size} flashcards{usage && ` · ${usage}`}
      </p>
      <div className="set-actions">
        <button className="ui-btn" onClick={exportAll}>
          <Download size={14} /> Export all pages as Markdown
        </button>
        <button
          className="ui-btn ghost"
          onClick={async () => {
            const ok = await navigator.storage?.persist?.();
            toast({ message: ok ? 'Storage marked persistent — the browser will not evict it' : 'The browser declined persistent storage' });
          }}
        >
          Keep data persistent
        </button>
      </div>
    </Section>
  );
}
