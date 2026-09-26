/**
 * Subscription bridging: lets users spend their existing ChatGPT / Claude subscription
 * instead of an API key. `complete()` publishes a pending request on `bridgeRequests`; a UI
 * dialog (AIBridgeDialog) copies the prompt, opens the chat site in a new tab (inside the
 * user's click, so pop-up blockers allow it) and resolves the request with the pasted answer.
 */
import type { AIConfig, AIProvider, AIRequest, AITask } from './types';
import { AIUnavailableError } from './errors';
import { bridgePromptText } from './prompts';
import { Emitter } from '../util/emitter';
import { uid } from '../util/ids';

export type BridgeTarget = 'chatgpt' | 'claude';

export const BRIDGE_TARGETS: Record<BridgeTarget, { label: string; url: string }> = {
  chatgpt: { label: 'ChatGPT', url: 'https://chatgpt.com/' },
  claude: { label: 'Claude', url: 'https://claude.ai/new' },
};

export interface BridgeRequest {
  id: string;
  task: AITask;
  /** the full text to paste into the chat */
  prompt: string;
  /** the request asks for JSON (the dialog can hint at that) */
  json: boolean;
  target: BridgeTarget;
  /** settle with the answer pasted by the user */
  resolve(answer: string): void;
  /** settle as cancelled */
  cancel(reason?: string): void;
}

/** New pending bridge requests; the dialog subscribes. */
export const bridgeRequests = new Emitter<BridgeRequest>();
/** Ids of requests that settled (answered, cancelled or aborted) so the dialog can close them. */
export const bridgeSettled = new Emitter<string>();

/** Copies the prompt and opens the chat site. Call from a click handler. */
export async function copyAndOpen(req: BridgeRequest, target: BridgeTarget = req.target): Promise<boolean> {
  let copied = false;
  try {
    await navigator.clipboard.writeText(req.prompt);
    copied = true;
  } catch {
    /* clipboard denied: the dialog shows the prompt for manual copy */
  }
  window.open(BRIDGE_TARGETS[target].url, '_blank', 'noopener');
  return copied;
}

/** Strips a single wrapping code fence from a pasted answer. */
export function cleanPastedAnswer(text: string): string {
  const t = text.trim();
  const m = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(t);
  return (m ? m[1] : t).trim();
}

export class BridgeProvider implements AIProvider {
  readonly id = 'bridge' as const;
  readonly label = 'Your ChatGPT / Claude subscription';
  readonly supportsImages = false;

  constructor(private readonly getConfig: () => AIConfig['bridge']) {}

  isConfigured(): boolean {
    return !!this.getConfig()?.enabled && typeof window !== 'undefined';
  }

  complete(req: AIRequest, signal?: AbortSignal): Promise<string> {
    if (bridgeRequests.size === 0) {
      return Promise.reject(new AIUnavailableError('the AI bridge dialog is not mounted', req.task, this.id));
    }
    return new Promise<string>((resolve, reject) => {
      const id = uid(8);
      let done = false;
      const settle = (fn: () => void) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
        bridgeSettled.emit(id);
      };
      const onAbort = () => settle(() => reject(signal!.reason ?? new DOMException('Aborted', 'AbortError')));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      bridgeRequests.emit({
        id,
        task: req.task,
        prompt: bridgePromptText(req),
        json: !!req.json,
        target: this.getConfig()?.target ?? 'claude',
        resolve: (answer) => {
          const text = cleanPastedAnswer(answer);
          settle(() => (text ? resolve(text) : reject(new AIUnavailableError('no answer was pasted', req.task, 'bridge'))));
        },
        cancel: (reason) => settle(() => reject(new AIUnavailableError(reason ?? 'cancelled by the user', req.task, 'bridge'))),
      });
    });
  }
}
