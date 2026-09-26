import { useMemo, type ReactNode } from 'react';
import { EditorEnvContext, type EditorEnv } from '../desk/editorContext';
import { useServices } from './services';
import { openPageByTitle } from './actions';
import { pickFile } from '../util/download';
import { useUI } from './store';
import type { AppServices } from './bootstrap';

/** Supplies completion data and navigation to every block editor. */
export function EditorEnvProvider({ children }: { children: ReactNode }) {
  const services = useServices() as AppServices;
  const env = useMemo<EditorEnv>(
    () => ({
      pageTitles() {
        const titles = new Set<string>();
        for (const p of services.vault.listPages()) if (p.kind !== 'daily' && p.kind !== 'sidequest') titles.add(p.title);
        for (const c of services.graph.concepts()) titles.add(c.title);
        return [...titles];
      },
      tagNames() {
        return services.graph
          .concepts()
          .sort((a, b) => b.count - a.count)
          .map((c) => c.title);
      },
      openPage: (title, opts) => openPageByTitle(title, opts),
      openBlockRef(blockId) {
        for (const b of services.graph.allBlocks()) {
          if (b.blockId === blockId) return useUI.getState().navigate({ name: 'page', pageId: b.pageId, blockId });
        }
      },
      async pickImage() {
        const [f] = await pickFile('image/*');
        return f ?? null;
      },
    }),
    [services],
  );
  return <EditorEnvContext.Provider value={env}>{children}</EditorEnvContext.Provider>;
}
