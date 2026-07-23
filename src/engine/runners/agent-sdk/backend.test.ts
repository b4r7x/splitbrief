import { describe, it, expect, vi } from 'vitest';
import { createAgentSdkBackend } from './backend.js';

describe('createAgentSdkBackend', () => {
  it('honors an already-aborted signal before loading the optional SDK peer', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const backend = createAgentSdkBackend({
      allowedTools: ['Read'],
      permissionMode: 'acceptEdits',
      role: 'implementer',
    });
    await expect(
      backend.invoke({
        prompt: 'hello',
        projectDir: '/tmp/proj',
        model: 'claude-sonnet-4-5',
        onOutput: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });

  it('idle kill aborts the SDK query when invoked without an external signal', async () => {
    let queryAbortController: AbortController | undefined;
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: (params: { options: { abortController?: AbortController } }) => {
        queryAbortController = params.options.abortController;
        return {
          [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
            next: () => new Promise<IteratorResult<never>>(() => {}),
          }),
        };
      },
    }));
    try {
      const backend = createAgentSdkBackend({
        allowedTools: ['Read'],
        permissionMode: 'acceptEdits',
        role: 'implementer',
        idleWarnMs: 10,
        idleKillMs: 25,
      });

      await expect(
        backend.invoke({
          prompt: 'hello',
          projectDir: '/tmp/proj',
          model: 'claude-sonnet-4-5',
          onOutput: () => {},
        }),
      ).rejects.toMatchObject({ kind: 'command-idle-timeout' });

      expect(queryAbortController).toBeDefined();
      expect(queryAbortController?.signal.aborted).toBe(true);
    } finally {
      vi.doUnmock('@anthropic-ai/claude-agent-sdk');
    }
  });
});
