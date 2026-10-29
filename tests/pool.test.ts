import { describe, expect, it } from 'vitest';
import { mapLimited } from '../src/pool.js';

describe('mapLimited', () => {
  it('never runs more than the limit at once and keeps the order of the items', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });

  it('rejects with the first failure', async () => {
    await expect(mapLimited([1, 2], 2, (n) => (n === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(n)))).rejects.toThrow('boom');
  });
});
