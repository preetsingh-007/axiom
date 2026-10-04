import { describe, expect, it } from 'vitest';
import { serialized } from './emitter';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('serialized', () => {
  it('never overlaps runs and coalesces calls made while one is running', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const gates: (() => void)[] = [];
    const job = serialized(async () => {
      active++;
      runs++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => gates.push(r));
      active--;
    });
    const a = job();
    const b = job();
    const c = job();
    expect(b).toBe(c);
    expect(runs).toBe(1);
    gates.shift()!();
    await a;
    await tick();
    expect(runs).toBe(2);
    gates.shift()!();
    await b;
    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('runs the queued job even when the running one fails', async () => {
    let calls = 0;
    const job = serialized(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    });
    const first = job();
    const second = job();
    await expect(first).rejects.toThrow('boom');
    await second;
    expect(calls).toBe(2);
  });
});
