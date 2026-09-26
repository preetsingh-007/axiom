import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './components.css';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run?: () => void;
  separator?: boolean;
}

/** Anchored popover menu, rendered in a portal, closes on outside click / Escape. */
export function Menu({ anchor, items, onClose, align = 'start' }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void; align?: 'start' | 'end' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === 'end' ? r.right - w : r.left;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    setPos({ top, left });
  }, [anchor, align]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      const enabled = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const cur = enabled.indexOf(active);
        const next = e.key === 'ArrowDown' ? enabled[(cur + 1) % enabled.length] : enabled[(cur - 1 + enabled.length) % enabled.length];
        setActive(next);
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        items[active].run?.();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose, items, active]);

  return createPortal(
    <div ref={ref} className="ui-menu" role="menu" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ui-menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`ui-menu-item${it.danger ? ' danger' : ''}${active === i ? ' active' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              it.run?.();
              onClose();
            }}
          >
            <span className="ui-menu-icon">{it.icon}</span>
            <span className="ui-menu-label">{it.label}</span>
            {it.hint && <span className="ui-menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** A button that opens a Menu. */
export function MenuButton({ items, children, className, title, align }: { items: MenuItem[] | (() => MenuItem[]); children: ReactNode; className?: string; title?: string; align?: 'start' | 'end' }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        className={className ?? 'ui-icon-btn'}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        {children}
      </button>
      {anchor && <Menu anchor={anchor} items={typeof items === 'function' ? items() : items} onClose={() => setAnchor(null)} align={align} />}
    </>
  );
}
