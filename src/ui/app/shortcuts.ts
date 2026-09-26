import { useEffect } from 'react';
import { useUI } from './store';
import { createNote } from './actions';

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.closest('.cm-editor');
}

/** App-wide keyboard shortcuts. */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const ui = useUI.getState();
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.setPalette(!ui.paletteOpen);
      } else if (mod && e.key === '\\') {
        e.preventDefault();
        ui.toggleSidebar();
      } else if (mod && e.key === '.') {
        e.preventDefault();
        if (ui.sideQuest.open) ui.closeSideQuest();
        else ui.openSideQuest();
      } else if (mod && e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        createNote();
      } else if (!mod && !e.altKey && !isTyping(e)) {
        if (e.key === 'g' && e.shiftKey) ui.navigate({ name: 'graph' });
        else if (e.key === 'T' && e.shiftKey) ui.navigate({ name: 'stream' });
        else if (e.key === 'R' && e.shiftKey) ui.navigate({ name: 'review' });
        else if (e.key === '/' ) {
          e.preventDefault();
          ui.setPalette(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
