import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import type { RetryOptions } from '../../implementers/types.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';

function makeRecordingImplementer() {
  let received: RetryOptions | undefined;
  const implementer = makeImplementer({
    retry: async (opts: RetryOptions) => {
      received = opts;
      return { success: true, output: 'fixed', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  return { implementer, getReceived: () => received };
}

describe('makeImplementerRetryInvoker', () => {
  it('forwards invoke args and fixed options into the invoke-arg implementer', async () => {
    const { implementer, getReceived } = makeRecordingImplementer();
    const languageContext = buildLanguageContext('typescript');
    const config = makeConfig();
    const task = makeTask();
    const signal = new AbortController().signal;

    const invoker = makeImplementerRetryInvoker({
      context: defaultContext,
      kind: 'hint',
      languageContext,
      phase: 'implementing',
      onOutput: () => {},
    });

    const result = await invoker({
      task,
      lastError: 'boom',
      attempts: 3,
      projectDir: '/staged',
      config,
      implementer,
      signal,
      sandboxEnv: { FOO: 'bar' },
      fileIgnoreProjectDir: '/project',
      changeDetection: 'file-hashes',
    });

    expect(result).toEqual({
      success: true,
      output: 'fixed',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const received = getReceived();
    expect(received).toMatchObject({
      task,
      projectDir: '/staged',
      config,
      context: defaultContext,
      languageContext,
      error: 'boom',
      attempt: 3,
      kind: 'hint',
      phase: 'implementing',
      signal,
      sandboxEnv: { FOO: 'bar' },
      fileIgnoreProjectDir: '/project',
      changeDetection: 'file-hashes',
    });
  });

  it('routes to the override implementer and config when provided', async () => {
    const argImpl = makeRecordingImplementer();
    const override = makeRecordingImplementer();
    const overrideConfig = makeConfig({ implementer: { model: 'override-model' } });

    const invoker = makeImplementerRetryInvoker({
      context: defaultContext,
      kind: 'local',
      languageContext: buildLanguageContext('typescript'),
      phase: 'implementing',
      onOutput: () => {},
      implementer: override.implementer,
      config: overrideConfig,
    });

    await invoker({
      task: makeTask(),
      lastError: 'boom',
      attempts: 1,
      projectDir: '/staged',
      config: makeConfig({ implementer: { model: 'arg-model' } }),
      implementer: argImpl.implementer,
      fileIgnoreProjectDir: '/project',
    });

    expect(argImpl.getReceived()).toBeUndefined();
    expect(override.getReceived()?.config.implementer.model).toBe('override-model');
    expect(override.getReceived()?.kind).toBe('local');
  });
});
