/**
 * Compact ink toolbar (tools, 6 colours, 3 sizes) and the global keyboard shortcuts hook.
 *
 *   <InkToolbar />                 inline or floating (position it with `className`)
 *   useInkShortcuts()              mount once at app level: P pen, H highlighter, E eraser,
 *                                  L lasso, V pointer (ignored while typing)
 */
import { useEffect } from 'react';
import { Eraser, Highlighter, Lasso, MousePointer2, PenLine, type LucideIcon } from 'lucide-react';
import { CURRENT_INK } from '../../core/ink/render';
import { PEN_SIZES, useInkStore, type InkTool } from './inkStore';
import './ink.css';

interface ToolDef {
  id: InkTool;
  label: string;
  key: string;
  Icon: LucideIcon;
}

export const INK_TOOLS: ToolDef[] = [
  { id: 'none', label: 'Pointer', key: 'V', Icon: MousePointer2 },
  { id: 'pen', label: 'Pen', key: 'P', Icon: PenLine },
  { id: 'highlighter', label: 'Highlighter', key: 'H', Icon: Highlighter },
  { id: 'eraser', label: 'Eraser', key: 'E', Icon: Eraser },
  { id: 'lasso', label: 'Lasso (select, move, Beautify)', key: 'L', Icon: Lasso },
];

const SHORTCUTS: Record<string, InkTool> = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', v: 'none' };

/** True when keyboard input should go to a text field / editor rather than to shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = (target instanceof Element ? target : null) ?? (typeof document !== 'undefined' ? document.activeElement : null);
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  return !!el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, [role="textbox"]');
}

/** Global single-key tool shortcuts. Mount once (e.g. in the app shell). */
export function useInkShortcuts(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
      if (isEditableTarget(e.target)) return;
      const tool = SHORTCUTS[e.key.toLowerCase()];
      if (!tool) return;
      useInkStore.getState().setTool(tool);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

export interface InkToolbarProps {
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}

export function InkToolbar({ className, orientation = 'horizontal' }: InkToolbarProps) {
  const tool = useInkStore((s) => s.tool);
  const color = useInkStore((s) => s.color);
  const highlighterColor = useInkStore((s) => s.highlighterColor);
  const sizeIndex = useInkStore((s) => s.sizeIndex);
  const palette = useInkStore((s) => s.palette);
  const highlighterPalette = useInkStore((s) => s.highlighterPalette);
  const setTool = useInkStore((s) => s.setTool);
  const setColor = useInkStore((s) => s.setColor);
  const setSizeIndex = useInkStore((s) => s.setSizeIndex);

  const isHl = tool === 'highlighter';
  const colors = isHl ? highlighterPalette : palette;
  const current = isHl ? highlighterColor : color;
  const showStyle = tool === 'pen' || tool === 'highlighter';

  return (
    <div className={`ink-toolbar ink-toolbar-${orientation} ink-ui${className ? ` ${className}` : ''}`} role="toolbar" aria-label="Ink tools" aria-orientation={orientation}>
      <div className="ink-toolbar-group">
        {INK_TOOLS.map(({ id, label, key, Icon }) => (
          <button
            key={id}
            type="button"
            className="ink-tool-btn"
            aria-pressed={tool === id}
            aria-label={`${label} (${key})`}
            title={`${label} (${key})`}
            onClick={() => setTool(id)}
          >
            <Icon size={17} aria-hidden="true" />
          </button>
        ))}
      </div>
      {showStyle && (
        <>
          <span className="ink-toolbar-sep" aria-hidden="true" />
          <div className="ink-toolbar-group" role="radiogroup" aria-label="Colour">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={current === c}
                aria-label={c === CURRENT_INK ? 'Default ink' : `Colour ${c}`}
                className="ink-swatch"
                onClick={() => setColor(c)}
              >
                <span className="ink-swatch-dot" style={{ background: c === CURRENT_INK ? 'var(--ink-default)' : c, opacity: isHl ? 0.6 : 1 }} />
              </button>
            ))}
          </div>
          <span className="ink-toolbar-sep" aria-hidden="true" />
          <div className="ink-toolbar-group" role="radiogroup" aria-label="Size">
            {PEN_SIZES.map((_, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={sizeIndex === i}
                aria-label={['Fine', 'Medium', 'Bold'][i] ?? `Size ${i + 1}`}
                className="ink-size-btn"
                onClick={() => setSizeIndex(i)}
              >
                <span className="ink-size-dot" style={{ width: 4 + i * 3, height: 4 + i * 3 }} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default InkToolbar;
