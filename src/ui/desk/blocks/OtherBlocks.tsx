import { memo, useState } from 'react';
import type * as Y from 'yjs';
import { blockEmbed, blockText, type BlockMap } from '../../../core/blocks';
import { renderMath, escapeHtml } from '../../markdown/render';
import { BlockEditor } from '../LazyBlockEditor';
import { startTypeahead, useEditorEnv, useFocusRequest, usePageEditor, type FocusAt } from '../editorContext';
import { blockActions } from '../blockActions';
import { useYText } from '../../hooks/usePage';
import { useYSelect } from '../../hooks/useY';
import { Transclusion } from './Transclusion';

function useEditing(id: string, readOnly?: boolean) {
  const api = usePageEditor();
  const [editing, setEditing] = useState<FocusAt | null>(null);
  useFocusRequest(api, id, (at) => {
    if (!readOnly) setEditing(at);
  });
  return { api, editing, setEditing };
}

export const MathBlock = memo(function MathBlock({ block, id, readOnly }: { block: BlockMap; id: string; readOnly?: boolean }) {
  const ytext = blockText(block) as Y.Text;
  const tex = useYText(ytext);
  const env = useEditorEnv();
  const { api, editing, setEditing } = useEditing(id, readOnly);
  const preview = tex.trim() ? renderMath(tex, true) : '<span class="blk-math-empty">Empty equation</span>';
  if (editing !== null && api) {
    const a = blockActions(api, id);
    return (
      <div className="blk-math-edit">
        <div className="blk-math-src">
          <span className="blk-math-label">LaTeX</span>
          <BlockEditor
            ytext={ytext}
            mode="math"
            env={env}
            initialFocus={editing}
            placeholder="\\int_0^\\infty e^{-x^2}\\,dx"
            onBackspaceAtStart={(empty) => a.backspaceAtStart(empty)}
            onArrowOut={(d) => a.arrowOut(d)}
            onBlur={() => setEditing(null)}
            onEscape={() => setEditing(null)}
          />
        </div>
        <div className="blk-math-preview" dangerouslySetInnerHTML={{ __html: preview }} />
      </div>
    );
  }
  return (
    <div
      className="blk-math"
      role="button"
      tabIndex={0}
      aria-label={`Equation: ${tex}`}
      onClick={() => !readOnly && (startTypeahead(), setEditing('end'))}
      onKeyDown={(e) => e.key === 'Enter' && !readOnly && setEditing('end')}
      dangerouslySetInnerHTML={{ __html: preview }}
    />
  );
});

export const CodeBlock = memo(function CodeBlock({ block, id, readOnly }: { block: BlockMap; id: string; readOnly?: boolean }) {
  const ytext = blockText(block) as Y.Text;
  const code = useYText(ytext);
  const env = useEditorEnv();
  const lang = useYSelect(block, (b) => (b.get('lang') as string) ?? '');
  const { api, editing, setEditing } = useEditing(id, readOnly);
  if (editing !== null && api) {
    const a = blockActions(api, id);
    return (
      <div className="blk-code editing">
        <BlockEditor
          ytext={ytext}
          mode="code"
          env={env}
          initialFocus={editing}
          placeholder="// code"
          onBackspaceAtStart={(empty) => a.backspaceAtStart(empty)}
          onArrowOut={(d) => a.arrowOut(d)}
          onBlur={() => setEditing(null)}
          onEscape={() => setEditing(null)}
        />
      </div>
    );
  }
  return (
    <pre className="blk-code" onClick={() => !readOnly && (startTypeahead(), setEditing('end'))} data-lang={lang}>
      <code dangerouslySetInnerHTML={{ __html: code ? escapeHtml(code) : '<span class="blk-faint">Empty code block</span>' }} />
    </pre>
  );
});

export { ImageBlock, SlideBlock } from './ImageBlocks';

export const EmbedBlock = memo(function EmbedBlock({ block }: { block: BlockMap }) {
  const embed = useYSelect(block, (b) => blockEmbed(b));
  if (!embed) return null;
  return <Transclusion pageId={embed.pageId} blockId={embed.blockId} />;
});
