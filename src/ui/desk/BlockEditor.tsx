import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder, drawSelection } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { autocompletion, closeBrackets, completionStatus, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { FocusAt, EditorEnv } from './editorContext';

export interface SlashCommand {
  id: string;
  label: string;
  detail: string;
  keywords?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'math', label: 'Math block', detail: 'Display LaTeX equation', keywords: 'latex equation formula' },
  { id: 'ink', label: 'Whiteboard', detail: 'Space to write & draw', keywords: 'ink draw sketch canvas pen' },
  { id: 'code', label: 'Code', detail: 'Code block', keywords: 'snippet program' },
  { id: 'image', label: 'Image', detail: 'Upload an image', keywords: 'picture figure photo' },
  { id: 'embed', label: 'Embed page', detail: 'Transclude another page', keywords: 'transclude include' },
  { id: 'flashcard', label: 'Flashcard', detail: 'Add this block to review', keywords: 'anki srs card cloze' },
  { id: 'cloze', label: 'Cloze deletion', detail: 'Insert {{c1::…}}', keywords: 'anki blank' },
  { id: 'today', label: "Today's date", detail: 'Link to today', keywords: 'date daily' },
  { id: 'text', label: 'Text', detail: 'Plain markdown paragraph', keywords: 'paragraph' },
];

export interface BlockEditorProps {
  ytext: Y.Text;
  mode: 'text' | 'math' | 'code';
  env: EditorEnv;
  initialFocus: FocusAt;
  placeholder?: string;
  onEnterSplit?: (before: string, after: string) => void;
  onBackspaceAtStart?: (isEmpty: boolean) => void;
  onArrowOut?: (dir: 'up' | 'down') => void;
  onSlash?: (cmd: string) => void;
  onBlur?: () => void;
  onEscape?: () => void;
  onDoubleDollar?: () => void;
  onInsertWhiteboard?: () => void;
}

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.45em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.25em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.1em', fontWeight: '650' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--link)' },
  { tag: t.url, color: 'var(--text-faint)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
  { tag: t.processingInstruction, color: 'var(--text-faint)' },
  { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--text-muted)' },
]);

const theme = EditorView.theme({
  '&': { background: 'transparent', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { padding: '0', caretColor: 'var(--accent)', fontFamily: 'inherit', lineHeight: 'inherit' },
  '.cm-line': { padding: '0' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'visible' },
  '.cm-placeholder': { color: 'var(--text-faint)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'var(--accent-soft) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-tooltip': { background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-ui)', maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '6px 10px !important', lineHeight: '1.3' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--text-faint)', fontStyle: 'normal', marginLeft: '8px', fontSize: '0.85em' },
  '.cm-completionIcon': { display: 'none' },
});

function wikiSource(env: EditorEnv) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\[\[[^\]\n]*$/);
    if (!m) return null;
    const query = m.text.slice(2).toLowerCase();
    const titles = env.pageTitles();
    const scored = titles
      .map((title) => {
        const l = title.toLowerCase();
        const i = l.indexOf(query);
        return { title, score: i < 0 ? -1 : (i === 0 ? 2 : 1) - l.length / 1000 };
      })
      .filter((x) => x.score >= 0 || !query)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    const hasClose = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === ']]';
    const options = scored.map(({ title }) => ({ label: title, apply: hasClose ? title : title + ']]', type: 'page' }));
    if (query && !titles.some((x) => x.toLowerCase() === query)) {
      const raw = m.text.slice(2);
      options.push({ label: raw, apply: hasClose ? raw : raw + ']]', type: 'new', detail: 'new page' } as (typeof options)[number]);
    }
    return { from: m.from + 2, options, validFor: /^[^\]\n]*$/ };
  };
}

function tagSource(env: EditorEnv) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/(?:^|\s)#[\p{L}\p{N}_-]*$/u);
    if (!m) return null;
    const hashAt = m.text.indexOf('#');
    const query = m.text.slice(hashAt + 1).toLowerCase();
    if (!query && !ctx.explicit) return null;
    const options = env
      .tagNames()
      .filter((x) => x.toLowerCase().startsWith(query))
      .slice(0, 40)
      .map((tag) => ({ label: tag, apply: /\s/.test(tag) ? `[[${tag}]]` : tag, type: 'tag' }));
    if ('flashcard'.startsWith(query) && !options.some((o) => o.label === 'flashcard')) options.unshift({ label: 'flashcard', apply: 'flashcard', type: 'tag' });
    return { from: m.from + hashAt + 1, options, validFor: /^[\p{L}\p{N}_-]*$/u };
  };
}

function slashSource(onSlash?: (cmd: string) => void) {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (!onSlash) return null;
    const m = ctx.matchBefore(/^\/[\w-]*$/);
    if (!m || m.from !== 0) return null;
    return {
      from: 0,
      filter: true,
      options: SLASH_COMMANDS.map((c) => ({
        label: '/' + c.id,
        displayLabel: c.label,
        detail: c.detail,
        type: 'slash',
        boost: 0,
        apply: (view: EditorView) => {
          view.dispatch({ changes: { from: 0, to: ctx.pos, insert: '' } });
          onSlash(c.id);
        },
      })),
    };
  };
}

/**
 * CodeMirror 6 editor bound to a block's Y.Text (y-codemirror.next). Created only for the
 * block being edited, so a page with thousands of blocks stays light.
 */
export function BlockEditor(props: BlockEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const { ytext, mode, env, initialFocus } = propsRef.current;
    const undoManager = new Y.UndoManager(ytext, { captureTimeout: 400 });
    const p = () => propsRef.current;

    const blockKeys = keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false;
          if (mode !== 'text' || !p().onEnterSplit) return false;
          const sel = view.state.selection.main;
          const doc = view.state.doc.toString();
          // inside a fenced code region or display math: plain newline
          const before = doc.slice(0, sel.from);
          if ((before.match(/```/g)?.length ?? 0) % 2 === 1 || (before.match(/\$\$/g)?.length ?? 0) % 2 === 1) return false;
          p().onEnterSplit!(before, doc.slice(sel.to));
          return true;
        },
      },
      {
        key: 'Mod-Enter',
        run: () => {
          if (mode === 'text') return false;
          p().onEscape?.();
          return true;
        },
      },
      {
        key: 'Mod-Shift-Enter',
        run: () => {
          p().onInsertWhiteboard?.();
          return true;
        },
      },
      {
        key: 'Backspace',
        run: (view) => {
          const sel = view.state.selection.main;
          if (!sel.empty || sel.from !== 0) return false;
          p().onBackspaceAtStart?.(view.state.doc.length === 0);
          return !!p().onBackspaceAtStart;
        },
      },
      {
        key: 'ArrowUp',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false;
          const sel = view.state.selection.main;
          const line = view.state.doc.lineAt(sel.head);
          if (line.number !== 1 || !sel.empty) return false;
          // only leave the block when the caret is on the first *visual* line
          const coords = view.coordsAtPos(sel.head);
          const top = view.coordsAtPos(0);
          if (coords && top && coords.top - top.top > 4) return false;
          p().onArrowOut?.('up');
          return true;
        },
      },
      {
        key: 'ArrowDown',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false;
          const sel = view.state.selection.main;
          const line = view.state.doc.lineAt(sel.head);
          if (line.number !== view.state.doc.lines || !sel.empty) return false;
          const coords = view.coordsAtPos(sel.head);
          const end = view.coordsAtPos(view.state.doc.length);
          if (coords && end && end.top - coords.top > 4) return false;
          p().onArrowOut?.('down');
          return true;
        },
      },
      {
        key: 'Escape',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false;
          p().onEscape?.();
          return true;
        },
      },
    ]);

    const exts: Extension[] = [
      yCollab(ytext, null, { undoManager }),
      Prec.highest(blockKeys),
      keymap.of([...yUndoManagerKeymap, ...(mode === 'code' ? [indentWithTab] : []), ...defaultKeymap]),
      EditorView.lineWrapping,
      drawSelection(),
      theme,
      EditorView.contentAttributes.of({ 'aria-label': mode === 'math' ? 'LaTeX' : 'Block text', spellcheck: mode === 'text' ? 'true' : 'false', autocapitalize: 'sentences' }),
      EditorView.domEventHandlers({
        blur: (_e, view) => {
          // keep editing while interacting with the completion popup
          setTimeout(() => {
            if (!view.hasFocus) p().onBlur?.();
          }, 120);
          return false;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || mode !== 'text') return;
        const text = u.state.doc.toString();
        if (text === '$$' && p().onDoubleDollar) {
          p().onDoubleDollar!();
        }
      }),
    ];
    if (props.placeholder) exts.push(cmPlaceholder(props.placeholder));
    if (mode === 'text') {
      exts.push(
        markdown(),
        syntaxHighlighting(highlight),
        closeBrackets(),
        autocompletion({ override: [slashSource(p().onSlash), wikiSource(env), tagSource(env)], icons: false, defaultKeymap: true, activateOnTyping: true }),
      );
    }

    const view = new EditorView({
      state: EditorState.create({ doc: ytext.toString(), extensions: exts }),
      parent: host.current!,
    });
    const len = view.state.doc.length;
    const pos = initialFocus === 'start' ? 0 : initialFocus === 'end' ? len : Math.max(0, Math.min(len, initialFocus));
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
    view.focus();
    // keep the caret visible without jumping the page
    requestAnimationFrame(() => view.dom.scrollIntoView({ block: 'nearest' }));

    return () => {
      view.destroy();
      undoManager.destroy();
    };
    // the editor is created once per edit session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.ytext]);

  return <div ref={host} className={`blk-editor blk-editor-${props.mode}`} />;
}
