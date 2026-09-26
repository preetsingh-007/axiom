import { useEffect, useRef, useState } from 'react';
import { Check, ClipboardCopy, ExternalLink, X } from 'lucide-react';
import {
  BRIDGE_TARGETS,
  bridgeRequests,
  bridgeSettled,
  copyAndOpen,
  type BridgeRequest,
  type BridgeTarget,
} from '../../core/ai/bridge';
import './AIBridgeDialog.css';

const TASK_LABEL: Record<BridgeRequest['task'], string> = {
  handwriting: 'Transcribe handwriting',
  'math-ocr': 'Convert math to LaTeX',
  summarize: 'Summarize',
  tags: 'Suggest tags',
  cloze: 'Generate flashcards',
  latex: 'Convert to LaTeX',
  chat: 'Ask',
};

/**
 * Subscription-bridge dialog. Mount once, globally: while mounted, the 'bridge' AI provider
 * is usable. Shows one pending request at a time — copy the prompt, open ChatGPT/Claude,
 * paste the reply back.
 */
export function AIBridgeDialog() {
  const [pending, setPending] = useState<BridgeRequest[]>([]);
  const [answer, setAnswer] = useState('');
  const [target, setTarget] = useState<BridgeTarget>('claude');
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const req = pending[0];

  useEffect(() => {
    const offReq = bridgeRequests.on((r) => setPending((p) => [...p, r]));
    const offSettled = bridgeSettled.on((id) => setPending((p) => p.filter((r) => r.id !== id)));
    return () => {
      offReq();
      offSettled();
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    setAnswer('');
    setCopied('idle');
    setTarget(req.target);
  }, [req]);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        req.cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);

  if (!req) return null;

  const open = async () => {
    const ok = await copyAndOpen(req, target);
    setCopied(ok ? 'copied' : 'failed');
    textRef.current?.focus();
  };
  const copyOnly = async () => {
    try {
      await navigator.clipboard.writeText(req.prompt);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };
  const submit = () => {
    if (answer.trim()) req.resolve(answer);
  };

  return (
    <div className="rv-bridge-backdrop" onMouseDown={(e) => e.target === e.currentTarget && req.cancel()}>
      <div className="rv-bridge" role="dialog" aria-modal="true" aria-labelledby="rv-bridge-title">
        <header className="rv-bridge-head">
          <div>
            <div className="rv-bridge-eyebrow">Use your subscription{pending.length > 1 ? ` · 1 of ${pending.length}` : ''}</div>
            <h2 id="rv-bridge-title">{TASK_LABEL[req.task]}</h2>
          </div>
          <button type="button" className="rv-bridge-x" aria-label="Cancel" onClick={() => req.cancel()}>
            <X size={18} />
          </button>
        </header>

        <ol className="rv-bridge-steps">
          <li>
            <div className="rv-bridge-step-title">Copy the prompt and open a chat</div>
            <div className="rv-bridge-targets" role="radiogroup" aria-label="Chat service">
              {(Object.keys(BRIDGE_TARGETS) as BridgeTarget[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={target === t}
                  className={`rv-bridge-target${target === t ? ' is-on' : ''}`}
                  onClick={() => setTarget(t)}
                >
                  {BRIDGE_TARGETS[t].label}
                </button>
              ))}
            </div>
            <div className="rv-bridge-row">
              <button type="button" className="rv-bridge-btn rv-bridge-primary" onClick={open}>
                <ExternalLink size={16} aria-hidden />
                Copy &amp; open {BRIDGE_TARGETS[target].label}
              </button>
              <button type="button" className="rv-bridge-btn" onClick={copyOnly}>
                {copied === 'copied' ? <Check size={16} aria-hidden /> : <ClipboardCopy size={16} aria-hidden />}
                {copied === 'copied' ? 'Copied' : 'Copy only'}
              </button>
            </div>
            {copied === 'failed' && <p className="rv-bridge-warn">Clipboard access was blocked — copy the prompt below manually.</p>}
            <details className="rv-bridge-prompt" open={copied === 'failed'}>
              <summary>Show prompt</summary>
              <pre>{req.prompt}</pre>
            </details>
          </li>
          <li>
            <label className="rv-bridge-step-title" htmlFor="rv-bridge-answer">
              Paste the reply
            </label>
            <textarea
              id="rv-bridge-answer"
              ref={textRef}
              className="rv-bridge-text"
              value={answer}
              placeholder={req.json ? 'Paste the JSON the chat returned…' : 'Paste the answer here…'}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={6}
            />
          </li>
        </ol>

        <footer className="rv-bridge-foot">
          <button type="button" className="rv-bridge-btn" onClick={() => req.cancel()}>
            Cancel
          </button>
          <button type="button" className="rv-bridge-btn rv-bridge-primary" disabled={!answer.trim()} onClick={submit}>
            Use answer
          </button>
        </footer>
      </div>
    </div>
  );
}
