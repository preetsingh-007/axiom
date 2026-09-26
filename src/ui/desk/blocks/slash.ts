import { blockActions } from '../blockActions';
import type { EditorEnv, PageEditorApi } from '../editorContext';
import { isoDate } from '../../../core/util/ids';
import { importImageBlock } from './imageImport';

/** Executes a slash command chosen in the editor's `/` menu. */
export function runSlash(cmd: string, api: PageEditorApi, id: string, env: EditorEnv) {
  const a = blockActions(api, id);
  switch (cmd) {
    case 'math':
      a.replaceOrInsert({ type: 'math', text: '' });
      break;
    case 'code':
      a.replaceOrInsert({ type: 'code', text: '' });
      break;
    case 'ink':
      a.replaceOrInsert({ type: 'ink', height: 400 });
      break;
    case 'text':
      break;
    case 'image':
      void env.pickImage().then(async (file) => {
        if (file) await importImageBlock(api, id, file);
      });
      break;
    case 'embed':
      a.insertTextAt(0, '![[');
      api.focus(id, 3);
      break;
    case 'flashcard':
      a.appendText('#flashcard');
      api.focus(id, 'end');
      break;
    case 'cloze':
      a.insertTextAt(0, '{{c1::answer}}');
      api.focus(id, 6);
      break;
    case 'today':
      a.insertTextAt(0, `[[${isoDate()}]] `);
      api.focus(id, 'end');
      break;
  }
}
