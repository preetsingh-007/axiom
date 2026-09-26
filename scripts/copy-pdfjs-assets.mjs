// Copies pdf.js static assets (CMaps, standard fonts, wasm decoders, ICC profiles) into
// public/pdfjs so they are served (and precached by the service worker) for offline use.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
const out = join(process.cwd(), 'public', 'pdfjs');
mkdirSync(out, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = join(root, dir);
  if (existsSync(src)) cpSync(src, join(out, dir), { recursive: true });
}
console.log('[axiom] pdf.js assets copied to public/pdfjs');
