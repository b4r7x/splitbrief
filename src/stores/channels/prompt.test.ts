import { beforeEach, describe, expect, it } from 'vitest';
import { createPromptChannel } from './prompt.js';

type TestRequest = { id: string };
type TestResponse = { value: string };

type TestState =
  | { status: 'idle' }
  | { status: 'pending'; request: TestRequest; resolve: (res: TestResponse) => void };

describe('createPromptChannel', () => {
  let state: TestState;

  const channel = createPromptChannel<TestRequest, TestResponse>({
    get: () => state,
    setPending: (request, resolve) => {
      state = { status: 'pending', request, resolve };
    },
    setIdle: () => {
      state = { status: 'idle' };
    },
    supersededValue: { value: 'superseded' },
    cancelledValue: { value: 'cancelled' },
  });

  beforeEach(() => {
    state = { status: 'idle' };
  });

  it('open → supersede → explicit close and default close settle promises at the public seam', async () => {
    const first = channel.open({ id: 'one' });
    expect(state.status).toBe('pending');
    if (state.status === 'pending') {
      expect(state.request.id).toBe('one');
    }

    const second = channel.open({ id: 'two' });
    await expect(first).resolves.toEqual({ value: 'superseded' });
    expect(state.status).toBe('pending');
    if (state.status === 'pending') {
      expect(state.request.id).toBe('two');
    }

    channel.close({ value: 'explicit' });
    expect(state.status).toBe('idle');
    await expect(second).resolves.toEqual({ value: 'explicit' });

    const third = channel.open({ id: 'three' });
    channel.close();
    expect(state.status).toBe('idle');
    await expect(third).resolves.toEqual({ value: 'cancelled' });
  });
});
