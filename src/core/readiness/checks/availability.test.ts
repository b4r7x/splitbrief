import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { buildRunnerChecks } from './runners.js';
import type { RunnerAvailabilityFact } from './availability.js';

function ollamaConfig() {
  return makeConfig({
    planner: { kind: 'cli', tool: 'claude-code' },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      model: 'qwen3-coder:30b',
      apiBase: 'http://localhost:11434/v1',
    },
  });
}

function defaultImplementerFact(
  verdict: RunnerAvailabilityFact['verdict'],
  provider = 'ollama',
): RunnerAvailabilityFact {
  return {
    slot: { role: 'implementer', profile: 'default' },
    provider,
    endpoint: 'http://localhost:11434/v1',
    verdict,
  };
}

function availabilityChecks(
  config: ReturnType<typeof makeConfig>,
  facts: readonly RunnerAvailabilityFact[],
) {
  return buildRunnerChecks(config, [], facts).filter((check) =>
    check.id.startsWith('runners.availability'),
  );
}

describe('runner availability checks', () => {
  it('blocks the run when the default implementer endpoint is unreachable, and names the remedy', () => {
    const [check] = availabilityChecks(ollamaConfig(), [
      defaultImplementerFact({ state: 'unavailable', diagnostic: 'fetch failed' }),
    ]);

    expect(check).toMatchObject({
      id: 'runners.availability.implementer.default',
      severity: 'blocker',
      summary:
        'Default implementer ollama (qwen3-coder:30b) is not reachable at http://localhost:11434/v1.',
      details: ['Probe: fetch failed'],
      fix: 'Run `ollama serve`, or configure a different implementer, then run `splitbrief doctor` again.',
      metadata: { availability: 'unavailable', provider: 'ollama' },
    });
  });

  it('blocks an unreachable planner endpoint', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
        model: 'some-model',
        apiBase: 'https://openrouter.ai/api/v1',
      },
    });

    const [check] = availabilityChecks(config, [
      {
        slot: { role: 'planner' },
        provider: 'openrouter',
        endpoint: 'https://openrouter.ai/api/v1',
        verdict: { state: 'unavailable', diagnostic: 'HTTP 503' },
      },
    ]);

    expect(check).toMatchObject({
      id: 'runners.availability.planner',
      severity: 'blocker',
      summary: 'Planner openrouter (some-model) is not reachable at https://openrouter.ai/api/v1.',
      fix: 'Check the openrouter endpoint and network, or configure a different planner, then run `splitbrief doctor` again.',
    });
  });

  it('names the missing credential environment variable', () => {
    const [check] = availabilityChecks(ollamaConfig(), [
      {
        ...defaultImplementerFact({
          state: 'missing-credential',
          credentialEnv: 'OPENROUTER_API_KEY',
        }),
        provider: 'openrouter',
      },
    ]);

    expect(check).toMatchObject({
      severity: 'blocker',
      summary: 'Default implementer ollama (qwen3-coder:30b) has no credential configured.',
      fix: 'Export OPENROUTER_API_KEY, or configure a different implementer, then run `splitbrief doctor` again.',
    });
  });

  it('blocks an endpoint that answers with an empty catalog instead of calling it available', () => {
    const [check] = availabilityChecks(ollamaConfig(), [
      defaultImplementerFact({ state: 'no-models' }),
    ]);

    expect(check).toMatchObject({
      severity: 'blocker',
      summary:
        'Default implementer ollama (qwen3-coder:30b) answered at http://localhost:11434/v1 but offers no models.',
      metadata: { availability: 'no-models' },
    });
  });

  it('reports a probe that could not run as not probed, never as available', () => {
    const [check] = availabilityChecks(ollamaConfig(), [
      defaultImplementerFact({
        state: 'not-probed',
        diagnostic: 'The operation was aborted due to timeout',
      }),
    ]);

    expect(check).toMatchObject({
      severity: 'info',
      summary: 'Default implementer ollama (qwen3-coder:30b) availability was not probed.',
      details: ['Probe: The operation was aborted due to timeout'],
      metadata: { availability: 'not-probed' },
    });
    expect(check?.fix).toBeUndefined();
  });

  it('passes a reachable endpoint', () => {
    const [check] = availabilityChecks(ollamaConfig(), [
      defaultImplementerFact({ state: 'available' }),
    ]);

    expect(check).toMatchObject({
      severity: 'ok',
      summary:
        'Default implementer ollama (qwen3-coder:30b) is available at http://localhost:11434/v1.',
    });
  });

  it('keeps a non-default implementer profile advisory', () => {
    const config = makeConfig({
      implementerProfiles: {
        default: 'primary',
        profiles: {
          primary: {
            kind: 'api',
            provider: 'ollama',
            model: 'a',
            apiBase: 'http://localhost:11434/v1',
          },
          spare: {
            kind: 'api',
            provider: 'ollama',
            model: 'b',
            apiBase: 'http://localhost:11434/v1',
          },
        },
      },
    });

    const checks = availabilityChecks(config, [
      {
        slot: { role: 'implementer', profile: 'spare' },
        provider: 'ollama',
        endpoint: 'http://localhost:11434/v1',
        verdict: { state: 'unavailable', diagnostic: 'fetch failed' },
      },
    ]);

    expect(checks[0]).toMatchObject({
      id: 'runners.availability.implementer.spare',
      severity: 'warning',
      summary:
        'Implementer profile spare ollama (b) is not reachable at http://localhost:11434/v1.',
    });
  });

  it('blocks the run when the reviewer seat is unreachable, and names the reviewer runner', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      reviewer: {
        kind: 'api',
        provider: 'openrouter',
        model: 'some-model',
        apiBase: 'https://openrouter.ai/api/v1',
      },
    });

    const checks = availabilityChecks(config, [
      {
        slot: { role: 'reviewer' },
        provider: 'openrouter',
        endpoint: 'https://openrouter.ai/api/v1',
        verdict: { state: 'unavailable', diagnostic: 'fetch failed' },
      },
    ]);

    expect(checks[0]).toMatchObject({
      id: 'runners.availability.reviewer',
      severity: 'blocker',
      nextAction: 'prepare-runner',
      summary: 'Reviewer openrouter (some-model) is not reachable at https://openrouter.ai/api/v1.',
      metadata: { role: 'reviewer' },
    });
    // The reviewer seat names its own runner and never borrows the planner's.
    expect(checks[0]?.summary).not.toContain('claude-code');
  });

  it('reports an agent-sdk runner without an endpoint', () => {
    const config = makeConfig({ implementer: { kind: 'agent-sdk', model: 'claude-opus-4' } });

    const [check] = availabilityChecks(config, [
      {
        slot: { role: 'implementer', profile: 'default' },
        provider: 'anthropic',
        verdict: {
          state: 'unavailable',
          diagnostic: 'Agent SDK not installed (npm install @anthropic-ai/claude-agent-sdk)',
        },
      },
    ]);

    expect(check).toMatchObject({
      severity: 'blocker',
      summary: 'Default implementer agent-sdk (claude-opus-4) is not reachable.',
      metadata: { endpoint: null },
    });
  });

  it('keeps the no-claim notice when no probe ran', () => {
    const checks = buildRunnerChecks(ollamaConfig(), []).filter((check) =>
      check.id.startsWith('runners.availability'),
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'runners.availability',
      severity: 'info',
      summary: 'Provider availability was not probed.',
    });
  });
});
