import { describe, it, expect } from 'vitest';
import { createWriteSequencer } from './serial-executor.js';

describe('createWriteSequencer', () => {
  it('runs queued functions one at a time in submission order', async () => {
    const sequence = createWriteSequencer();
    const order: string[] = [];

    const defer = (label: string, ms: number) =>
      sequence(async () => {
        order.push(`start:${label}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`end:${label}`);
      });

    await Promise.all([defer('a', 20), defer('b', 1), defer('c', 10)]);

    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('runs the first submission when no prior chain exists', async () => {
    const sequence = createWriteSequencer();
    const order: string[] = [];

    const result = await sequence(() => {
      order.push('only');
      return 42;
    });

    expect(result).toBe(42);
    expect(order).toEqual(['only']);
  });

  it('returns each function result to its own caller', async () => {
    const sequence = createWriteSequencer();

    const [first, second] = await Promise.all([
      sequence(() => 'first'),
      sequence(async () => 'second'),
    ]);

    expect(first).toBe('first');
    expect(second).toBe('second');
  });

  it('isolates a rejection so later functions still run', async () => {
    const sequence = createWriteSequencer();
    const order: string[] = [];

    const failing = sequence(async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const following = sequence(async () => {
      order.push('following');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
    expect(order).toEqual(['failing', 'following']);
  });
});
