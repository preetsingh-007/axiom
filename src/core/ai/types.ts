/**
 * Zero-cost AI routing contracts.
 *
 * Providers (all optional, user-configured, keys stored locally only):
 *  - 'local'     deterministic heuristics; always available, offline, instant
 *  - 'gemini'    Google AI Studio free tier (multimodal, huge context)
 *  - 'openai'    any OpenAI-compatible endpoint (OpenAI, OpenRouter free models, Ollama, LM Studio)
 *  - 'anthropic' user's own Anthropic API key
 *  - 'webllm'    on-device small language model via WebGPU (fully offline, private)
 *  - 'bridge'    "subscription bridging": copies the prompt to the clipboard, opens the user's
 *                ChatGPT/Claude web tab, and waits for the user to paste the answer back
 */

export type AITask =
  | 'handwriting' // image of handwriting -> plain text
  | 'math-ocr' // image of math (handwritten or typeset) -> LaTeX
  | 'summarize'
  | 'tags' // suggest concept tags
  | 'cloze' // generate cloze deletions
  | 'latex' // convert text/unicode math to LaTeX
  | 'chat';

export type ProviderId = 'local' | 'gemini' | 'openai' | 'anthropic' | 'webllm' | 'bridge';

export interface AIImage {
  mime: string;
  /** base64 without data: prefix */
  data: string;
}

export interface AIRequest {
  task: AITask;
  prompt: string;
  system?: string;
  images?: AIImage[];
  /** ask the provider for a JSON-only answer */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /**
   * The raw task input (e.g. the note text) without prompt scaffolding. Heuristic providers
   * ('local') work on this instead of the templated `prompt`.
   */
  input?: string;
  /** structured task parameters, used by heuristic providers */
  hints?: {
    /** tags already in the vault; suggestions should prefer these */
    existingTags?: string[];
    /** desired number of items (tags, summary sentences, cloze cards) */
    count?: number;
  };
}

export interface AIResult {
  text: string;
  provider: ProviderId;
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly supportsImages: boolean;
  /** true when configured and reachable enough to try */
  isConfigured(): boolean;
  /** optional task filter; providers without it are assumed to handle every task */
  supportsTask?(task: AITask): boolean;
  complete(req: AIRequest, signal?: AbortSignal): Promise<string>;
}

export interface AIConfig {
  /** ordered preference; the router tries each configured provider in turn */
  order: ProviderId[];
  gemini?: { apiKey: string; model: string };
  openai?: { baseUrl: string; apiKey?: string; model: string };
  anthropic?: { apiKey: string; model: string };
  webllm?: { model: string; enabled: boolean };
  bridge?: { target: 'chatgpt' | 'claude'; enabled: boolean };
}
