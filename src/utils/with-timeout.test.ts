import { describe, expect, test } from 'vitest';
import { timeoutError, withTimeout, withIdleTimeout } from './with-timeout.js';

describe('timeoutError.idle factory', () => {
  test.each([
    { message: undefined, expected: 'Idle timeout' },
    { message: 'Model response timed out', expected: 'Model response timed out' },
  ])('formats idle timeout errors', ({ message, expected }) => {
    const err = timeoutError.idle(message);

    expect(err).toMatchObject({
      kind: 'idle-timeout',
      message: expected,
      data: { message: expected },
    });
  });
});

describe('timeoutError.isIdle predicate', () => {
  test('matches idle factory output', () => {
    expect(timeoutError.isIdle(timeoutError.idle())).toBe(true);
    expect(timeoutError.isIdle(timeoutError.idle('custom'))).toBe(true);
  });

  test('rejects non-matching values', () => {
    for (const value of [new Error('plain'), null, { kind: 'idle-timeout' }]) {
      expect(timeoutError.isIdle(value)).toBe(false);
    }
  });
});

describe('withTimeout', () => {
  test('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 100);
    expect(result).toBe(42);
  });

  test('rejects with timeout error when promise does not resolve in time', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 1000));
    await expect(withTimeout(slow, 20)).rejects.toThrow('timeout');
  });

  test('propagates original rejection if it fires before timeout', async () => {
    const original = new Error('original failure');
    await expect(withTimeout(Promise.reject(original), 100)).rejects.toBe(original);
  });
});

describe('withIdleTimeout', () => {
  async function* fastGenerator(): AsyncGenerator<number> {
    yield 1;
    yield 2;
    yield 3;
  }

  async function* slowGenerator(): AsyncGenerator<number> {
    yield 1;
    await new Promise((resolve) => setTimeout(resolve, 500));
    yield 2;
  }

  test('yields all values when generator is fast', async () => {
    const values: number[] = [];
    for await (const v of withIdleTimeout(fastGenerator(), 100)) values.push(v);
    expect(values).toEqual([1, 2, 3]);
  });

  test('throws timeoutError.idle when iterator stalls', async () => {
    const values: number[] = [];
    try {
      for await (const v of withIdleTimeout(slowGenerator(), 20, 'Slow stream')) {
        values.push(v);
      }
      throw new Error('expected throw');
    } catch (err) {
      expect(timeoutError.isIdle(err)).toBe(true);
      if (timeoutError.isIdle(err)) {
        expect(err.data).toEqual({ message: 'Slow stream' });
      }
      expect(values).toEqual([1]);
    }
  });

  test('calls iterator.return when the iterator stalls', async () => {
    let returnCalled = false;
    const iterator: AsyncIterator<number> = {
      next: async () => new Promise<IteratorResult<number>>(() => {}),
      return: async () => {
        returnCalled = true;
        return { done: true, value: undefined };
      },
    };
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => iterator,
    };

    await expect((async () => {
      for await (const value of withIdleTimeout(iterable, 20)) {
        expect(value).toBeUndefined();
      }
    })()).rejects.toSatisfy(timeoutError.isIdle);
    expect(returnCalled).toBe(true);
  });

  test('calls iterator.return when the iterator rejects', async () => {
    const original = new Error('stream failed');
    let returnCalled = false;
    const iterator: AsyncIterator<number> = {
      next: async () => {
        throw original;
      },
      return: async () => {
        returnCalled = true;
        return { done: true, value: undefined };
      },
    };
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => iterator,
    };

    await expect((async () => {
      for await (const value of withIdleTimeout(iterable, 100)) {
        expect(value).toBeUndefined();
      }
    })()).rejects.toBe(original);
    expect(returnCalled).toBe(true);
  });

  test('runs generator cleanup after timeout once the pending next call settles', async () => {
    let cleanedUp = false;
    async function* cleanupGenerator(): AsyncGenerator<number> {
      try {
        yield 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield 2;
      } finally {
        cleanedUp = true;
      }
    }

    await expect((async () => {
      for await (const value of withIdleTimeout(cleanupGenerator(), 10)) {
        expect(value).toBe(1);
      }
    })()).rejects.toSatisfy(timeoutError.isIdle);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(cleanedUp).toBe(true);
  });
});
