import type { AIConfig, AIProvider, AIRequest } from './types';
import { postJSON, requireText } from './http';

/** Presets for the Settings UI: any OpenAI-compatible /chat/completions endpoint works. */
export const OPENAI_PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  lmstudio: { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
} as const;

interface ChatResponse {
  choices?: { message?: { content?: string | { type: string; text?: string }[] }; finish_reason?: string }[];
}

/**
 * OpenAI-compatible chat completions (OpenAI, OpenRouter, Ollama, LM Studio, …).
 * JSON is requested through the prompt rather than `response_format`, which many
 * compatible servers reject and which cannot return top-level arrays.
 */
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const;
  readonly label = 'OpenAI-compatible';
  readonly supportsImages = true;

  constructor(private readonly getConfig: () => AIConfig['openai']) {}

  isConfigured(): boolean {
    const c = this.getConfig();
    return !!(c?.baseUrl?.trim() && c.model?.trim());
  }

  async complete(req: AIRequest, signal?: AbortSignal): Promise<string> {
    const cfg = this.getConfig()!;
    const url = `${cfg.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {};
    if (cfg.apiKey?.trim()) headers.authorization = `Bearer ${cfg.apiKey.trim()}`;
    const messages: unknown[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({
      role: 'user',
      content: req.images?.length
        ? [
            { type: 'text', text: req.prompt },
            ...req.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })),
          ]
        : req.prompt,
    });
    const body: Record<string, unknown> = { model: cfg.model.trim(), messages, stream: false };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    const res = await postJSON<ChatResponse>(this.id, url, headers, body, signal);
    const content = res.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((p) => p.text ?? '').join('') : content;
    return requireText(this.id, text);
  }
}
