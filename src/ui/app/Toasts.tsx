import { X } from 'lucide-react';
import { useUI } from './store';

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  return (
    <div className="ui-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`ui-toast ${t.kind ?? ''}`}>
          <span>{t.message}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          {t.secondary && (
            <button
              onClick={() => {
                t.secondary!.run();
                dismiss(t.id);
              }}
            >
              {t.secondary.label}
            </button>
          )}
          <button aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
