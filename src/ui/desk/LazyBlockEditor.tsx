import { lazy, Suspense } from 'react';
import type { BlockEditorProps } from './BlockEditor';

const loadEditor = () => import('./BlockEditor');
const Impl = lazy(() => loadEditor().then((m) => ({ default: m.BlockEditor })));

/** Warm the CodeMirror chunk during idle time so the first click edits instantly. */
export function preloadEditor() {
  void loadEditor();
}

/**
 * CodeMirror is only needed for the block being edited, so it is code-split. While the chunk
 * loads (first edit only) the raw text is shown and keystrokes are buffered by the typeahead.
 */
export function BlockEditor(props: BlockEditorProps) {
  return (
    <Suspense fallback={<div className={`blk-editor blk-editor-${props.mode} blk-editor-loading`}>{props.ytext.toString() || '​'}</div>}>
      <Impl {...props} />
    </Suspense>
  );
}
