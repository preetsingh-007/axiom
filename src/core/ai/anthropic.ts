import type { AIConfig, AIProvider, AIRequest } from './types';
import { postJSON, requireText } from './http';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
}

/** Anthropic Messages API, called directly from the browser with the user's own key. */
export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  readonly label = 'Anthropic Claude';
  readonly supportsImages = true;

  constructor(private readonly getConfig: () => AIConfig['anthropic']) {}

  isConfigured(): boolean {
    return !!this.getConfig()?.apiKey?.trim();
  }

  async complete(req: AIRequest, signal?: AbortSignal): Promise<string> {
    const cfg = this.getConfig()!;
    const content: unknown[] = (req.images ?? []).map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mime, data: img.data },
    }));
    content.push({ type: 'text', text: req.prompt });
    const body: Record<string, unknown> = {
      model: cfg.model?.trim() || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: req.maxTokens ?? 4096,
      messages: [{ role: 'user', content }],
    };
    if (req.system) body.system = req.system;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const res = await postJSON<MessagesResponse>(
      this.id,
      ANTHROPIC_ENDPOINT,
      {
        'x-api-key': cfg.apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body,
      signal,
    );
    const text = (res.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return requireText(this.id, text, res.stop_reason === 'refusal' ? 'the model declined this request' : 'empty response');
  }
}
