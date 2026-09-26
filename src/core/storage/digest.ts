import * as Y from 'yjs';
import { hash64 } from '../util/ids';

/**
 * Digest of a doc's full CRDT state: state vector PLUS delete set. Deletions do not advance the
 * state vector, so hashing it alone would hide offline deletions from reconciliation.
 */
export function stateDigest(state: Uint8Array | null): string {
  if (!state) return 'empty';
  const sv = Y.encodeStateVectorFromUpdate(state);
  let s = '';
  for (let i = 0; i < sv.length; i++) s += String.fromCharCode(sv[i]);
  const { ds } = Y.decodeUpdate(state);
  const clients = [...ds.clients.keys()].sort((a, b) => a - b);
  for (const c of clients) {
    // canonical: sorted, coalesced ranges (fragmentation differs between merged update sets)
    const items = [...ds.clients.get(c)!].sort((a, b) => a.clock - b.clock);
    let start = -1;
    let end = -1;
    s += `|${c}:`;
    for (const it of items) {
      if (it.clock <= end) end = Math.max(end, it.clock + it.len);
      else {
        if (start >= 0) s += `${start}-${end},`;
        start = it.clock;
        end = it.clock + it.len;
      }
    }
    if (start >= 0) s += `${start}-${end}`;
  }
  return hash64(s);
}
