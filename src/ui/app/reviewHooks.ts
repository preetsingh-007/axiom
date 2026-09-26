import { useEffect, useState } from 'react';
import { useServices } from './services';
import { buildQueue, type QueueOptions, type AnswerOptions } from '../../core/srs';
import type { Vault } from '../../core/vault';

/** SRS options from the synced settings map. */
export function srsOptions(vault: Vault): QueueOptions & AnswerOptions {
  const get = (k: string) => vault.settings.get(k) as number | undefined;
  return {
    newPerDay: get('srs.newPerDay') ?? 20,
    leechThreshold: get('srs.leechThreshold') ?? 4,
    params: { requestRetention: get('srs.retention') ?? 0.9 },
  };
}

/** Number of cards due now (for the sidebar badge). Recomputed lazily on card changes. */
export function useDueCount(): number {
  const { vault } = useServices();
  const [n, setN] = useState(0);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const compute = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const q = buildQueue(vault, Date.now(), srsOptions(vault));
        setN(q.counts.new + q.counts.learning + q.counts.review);
      }, 250);
    };
    compute();
    vault.cards.observe(compute);
    const iv = setInterval(compute, 60_000);
    return () => {
      vault.cards.unobserve(compute);
      clearInterval(iv);
      clearTimeout(t);
    };
  }, [vault]);
  return n;
}
