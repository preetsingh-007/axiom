import type { AIConfig, AIProvider, AIRequest } from './types';
import { postJSON, requireText } from './http';

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiPart {
  text?: string;
  thought?: boolean;
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/** Google AI Studio (Gemini) via REST generateContent. Multimodal; JSON mode via responseMimeType. */
export class GeminiProvider implements AIProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Google Gemini';
  readonly supportsImages = true;

  constructor(private readonly getConfig: () => AIConfig['gemini']) {}

  isConfigured(): boolean {
    return !!this.getConfig()?.apiKey?.trim();
  }

  async complete(req: AIRequest, signal?: AbortSignal): Promise<string> {
    const cfg = this.getConfig()!;
    const model = cfg.model?.trim() || DEFAULT_GEMINI_MODEL;
    const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey.trim())}`;
    const parts: unknown[] = [{ text: req.prompt }];
    for (const img of req.images ?? []) parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
    if (req.json) generationConfig.responseMimeType = 'application/json';
    const body: Record<string, unknown> = { contents: [{ role: 'user', parts }], generationConfig };
    if (req.system) body.system_instruction = { parts: [{ text: req.system }] };

    const res = await postJSON<GeminiResponse>(this.id, url, {}, body, signal);
    if (res.promptFeedback?.blockReason) {
      return requireText(this.id, undefined, `request blocked (${res.promptFeedback.blockReason})`);
    }
    const cand = res.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    return requireText(this.id, text, cand?.finishReason ? `no text (finishReason ${cand.finishReason})` : 'empty response');
  }
}
