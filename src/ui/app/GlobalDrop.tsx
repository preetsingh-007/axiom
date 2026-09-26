import { useEffect, useState } from 'react';
import { FileUp } from 'lucide-react';
import { importFilesToLibrary } from '../library/importer';
import { useUI } from './store';

/** Drop PDFs / EPUBs / PPTX anywhere (outside the Desk) to import them into the Library. */
export function GlobalDrop() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const over_ = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = async (e: DragEvent) => {
      depth = 0;
      setOver(false);
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      const n = await importFilesToLibrary(files);
      if (n) {
        useUI.getState().toast({ message: `Imported ${n} document${n > 1 ? 's' : ''}`, kind: 'success' });
        if (useUI.getState().route.name !== 'library') useUI.getState().navigate({ name: 'library' });
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over_);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over_);
      window.removeEventListener('drop', drop);
    };
  }, []);
  if (!over) return null;
  return (
    <div className="global-drop" aria-hidden>
      <div className="global-drop-card">
        <FileUp size={28} />
        <div>Drop to add to your Library</div>
        <small>PDF · EPUB · PPTX — images drop straight onto the Desk</small>
      </div>
    </div>
  );
}
