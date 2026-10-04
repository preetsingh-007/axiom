/** Public surface of the zero-cost AI router. */
export type * from './types';
export * from './errors';
export { AIRouter, DEFAULT_TIMEOUTS, type AIRouterOptions } from './router';
export { AI_CONFIG_KEY, ALL_PROVIDERS, DEFAULT_AI_CONFIG, loadAIConfig, saveAIConfig, normalizeAIConfig, hasModelProvider } from './config';
export { probeProviders, PROBE_PROVIDERS, type ProbeResult } from './probe';
export { extractJSON } from './json';
export * from './prompts';
export { LocalProvider, summarizeText, extractKeyphrases, unicodeToLatex, splitSentences } from './local';
export { GeminiProvider, DEFAULT_GEMINI_MODEL } from './gemini';
export { OpenAIProvider, OPENAI_PRESETS } from './openai';
export { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic';
export { WebLLMProvider, DEFAULT_WEBLLM_MODEL, webllmProgress, hasWebGPU, type WebLLMProgress } from './webllm';
export {
  BridgeProvider,
  BRIDGE_TARGETS,
  bridgeRequests,
  bridgeSettled,
  copyAndOpen,
  cleanPastedAnswer,
  type BridgeRequest,
  type BridgeTarget,
} from './bridge';
