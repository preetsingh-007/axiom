/**
 * AI configuration lives in local-only storage (`vault.setLocal`): API keys never enter the
 * synced CRDT or Git.
 */
import type { AIConfig, ProviderId } from './types';
import type { Vault } from '../vault';
import { DEFAULT_WEBLLM_MODEL } from './webllm';

export const AI_CONFIG_KEY = 'ai-config';

export const ALL_PROVIDERS: readonly ProviderId[] = ['gemini', 'anthropic', 'openai', 'webllm', 'bridge', 'local'];

export const DEFAULT_AI_CONFIG: AIConfig = {
  order: [...ALL_PROVIDERS],
  webllm: { model: DEFAULT_WEBLLM_MODEL, enabled: false },
  bridge: { target: 'claude', enabled: false },
};

/** Fills defaults and drops unknown/duplicate provider ids. */
export function normalizeAIConfig(raw: Partial<AIConfig> | undefined | null): AIConfig {
  const cfg: AIConfig = { ...DEFAULT_AI_CONFIG, ...(raw ?? {}) };
  const order = Array.isArray(cfg.order) ? cfg.order.filter((id) => ALL_PROVIDERS.includes(id)) : [];
  cfg.order = [...new Set(order.length ? order : DEFAULT_AI_CONFIG.order)];
  cfg.webllm = { ...DEFAULT_AI_CONFIG.webllm!, ...(raw?.webllm ?? {}) };
  cfg.bridge = { ...DEFAULT_AI_CONFIG.bridge!, ...(raw?.bridge ?? {}) };
  return cfg;
}

export async function loadAIConfig(vault: Vault): Promise<AIConfig> {
  return normalizeAIConfig(await vault.getLocal<Partial<AIConfig>>(AI_CONFIG_KEY));
}

export async function saveAIConfig(vault: Vault, config: AIConfig): Promise<void> {
  await vault.setLocal(AI_CONFIG_KEY, normalizeAIConfig(config));
}
