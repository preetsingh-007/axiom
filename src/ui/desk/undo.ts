import * as Y from 'yjs';
import { blocksOf, orderOf } from '../../core/blocks';
import { LOCAL_ORIGIN } from '../../core/storage/docstore';
import { useUI } from '../app/store';

/**
 * Page-level undo for structural edits (insert / delete / move / convert blocks, ink strokes,
 * whiteboard resizing). Only this device's local changes are tracked — never a collaborator's.
 * Text inside a block has its own undo history in the editor.
 */
const managers = new WeakMap<Y.Doc, Y.UndoManager>();
let activeDoc: Y.Doc | null = null;

export function undoManagerFor(doc: Y.Doc): Y.UndoManager {
  let um = managers.get(doc);
  if (!um) {
    um = new Y.UndoManager([orderOf(doc), blocksOf(doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 400 });
    managers.set(doc, um);
  }
  return um;
}

export function setActiveDoc(doc: Y.Doc) {
  activeDoc = doc;
  undoManagerFor(doc);
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || !!el.closest('.cm-editor'));
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || isTyping(e.target) || !activeDoc) return;
    const um = managers.get(activeDoc);
    if (!um) return;
    const redo = e.shiftKey;
    const done = redo ? um.redo() : um.undo();
    e.preventDefault();
    if (!done) useUI.getState().toast({ message: redo ? 'Nothing to redo' : 'Nothing to undo', timeout: 1200 });
  });
}
