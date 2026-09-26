import { memo, useCallback, useContext, useLayoutEffect, useRef, useState, createContext, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type * as Y from 'yjs';
import { blockText, type BlockMap } from '../../../core/blocks';
import { renderMarkdown } from '../../markdown/render';
import { BlockEditor } from '../LazyBlockEditor';
import { useEditorEnv, useFocusRequest, usePageEditor, type FocusAt } from '../editorContext';
import { blockActions } from '../blockActions';
import { useYText } from '../../hooks/usePage';
import { Transclusion } from './Transclusion';
import { runSlash } from './slash';

/** Depth of nested transclusions (prevents infinite recursion A embeds B embeds A). */
export const TranscludeDepth = createContext(0);

/** Maps a click inside rendered markdown to an approximate caret offset in the source. */
function caretFromClick(e: MouseEvent, source: string): FocusAt {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(e.clientX, e.clientY);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return 'end';
  const text = node.textContent ?? '';
  for (const len of [16, 8, 4]) {
    const before = text.slice(Math.max(0, offset - len), offset);
    if (before.length >= Math.min(len, offset) && before) {
      const idx = source.indexOf(before);
      if (idx >= 0 && source.indexOf(before, idx + 1) < 0) return idx + before.length;
    }
    const after = text.slice(offset, offset + len);
    if (after) {
      const idx = source.indexOf(after);
      if (idx >= 0 && source.indexOf(after, idx + 1) < 0) return idx;
    }
  }
  return 'end';
}

interface Placeholder {
  el: Element;
  page: string;
  block?: string;
}

export const TextBlock = memo(function TextBlock({ block, id, readOnly }: { block: BlockMap; id: string; readOnly?: boolean }) {
  const ytext = blockText(block) as Y.Text;
  const text = useYText(ytext);
  const api = usePageEditor();
  const env = useEditorEnv();
  const [editing, setEditing] = useState<FocusAt | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const htmlRef = useRef<HTMLDivElement>(null);
  const [placeholders, setPlaceholders] = useState<Placeholder[]>([]);
  const depth = useContext(TranscludeDepth);

  useFocusRequest(api, id, (at) => {
    if (readOnly) return;
    setEditing(at);
    setFocusNonce((n) => n + 1);
  });

  const html = editing === null ? renderMarkdown(text) : '';

  useLayoutEffect(() => {
    if (editing !== null || !htmlRef.current) {
      setPlaceholders((p) => (p.length ? [] : p));
      return;
    }
    const found = [...htmlRef.current.querySelectorAll('.md-transclude')].map((el) => ({
      el,
      page: el.getAttribute('data-page') ?? '',
      block: el.getAttribute('data-block') ?? undefined,
    }));
    setPlaceholders((p) => (p.length === 0 && found.length === 0 ? p : found));
  }, [html, editing]);

  const onClick = useCallback(
    (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a');
      if (link) {
        const page = link.getAttribute('data-page');
        if (page) {
          e.preventDefault();
          e.stopPropagation();
          env.openPage(page, { sideQuest: e.shiftKey });
          return;
        }
        if (link.getAttribute('href') && link.getAttribute('href') !== '#') return; // external link
      }
      const ref = target.closest('.md-blockref');
      if (ref) {
        e.preventDefault();
        env.openBlockRef(ref.getAttribute('data-block') ?? '');
        return;
      }
      if (target.closest('.md-transclude')) return;
      if (readOnly || !api) return;
      if (window.getSelection()?.toString()) return; // user is selecting text to copy
      setEditing(caretFromClick(e, text));
    },
    [env, api, readOnly, text],
  );

  if (editing !== null && api) {
    const actions = blockActions(api, id);
    return (
      <BlockEditor
        ytext={ytext}
        mode="text"
        env={env}
        initialFocus={editing}
        focusNonce={focusNonce}
        placeholder="Type, or press / for commands, [[ to link"
        onEnterSplit={(b, a) => actions.split(b, a)}
        onBackspaceAtStart={(empty) => actions.backspaceAtStart(empty)}
        onArrowOut={(d) => actions.arrowOut(d)}
        onBlur={() => setEditing(null)}
        onEscape={() => setEditing(null)}
        onSlash={(cmd) => runSlash(cmd, api, id, env)}
        onDoubleDollar={() => {
          actions.convert('math');
          ytext.doc?.transact(() => ytext.delete(0, ytext.length));
        }}
        onInsertWhiteboard={() => {
          setEditing(null);
          actions.insertAfter({ type: 'ink', height: 360 }, false);
        }}
      />
    );
  }

  return (
    <>
      <div
        ref={htmlRef}
        className={`blk-rendered md${text.trim() ? '' : ' blk-empty'}`}
        onClick={onClick}
        data-placeholder={readOnly ? '' : depth ? '' : 'Click to write…'}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {depth < 3 &&
        placeholders.map((p, i) =>
          createPortal(
            <TranscludeDepth.Provider value={depth + 1}>
              <Transclusion title={p.page} blockId={p.block} />
            </TranscludeDepth.Provider>,
            p.el,
            `${p.page}#${p.block ?? ''}#${i}`,
          ),
        )}
    </>
  );
});
