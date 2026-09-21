import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { projectRunnerDiscoveryContext } from './runner-discovery-context.js';
import type { RunnerDiscoveryContext } from './runner-discovery-context.js';
import { runnerDiscoveryContextKey } from '../../../engine/detection/runner-evidence.js';
import type { ActiveRunnerRole } from '../../runners/seat-roles.js';
import type { Config } from '../../schemas/config.js';

const INLINE_KEY = 'sk-reviewer-inline-secret-value';

function apiSeat(overrides: Readonly<{ apiBase: string; apiKey?: string }>) {
  return {
    kind: 'api' as const,
    provider: 'local-studio',
    model: 'qwen2.5-coder:7b',
    apiBase: overrides.apiBase,
    contextLength: 32768,
    temperature: 0.2,
    ...(overrides.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
  };
}

function contextFor(config: Config, role: ActiveRunnerRole): RunnerDiscoveryContext {
  return projectRunnerDiscoveryContext({ config, role });
}

function keyFor(config: Config, role: ActiveRunnerRole): string {
  return runnerDiscoveryContextKey(contextFor(config, role));
}

const plannerAt = (apiBase: string, apiKey?: string): Config =>
  makeConfig({ planner: apiSeat({ apiBase, ...(apiKey === undefined ? {} : { apiKey }) }) });

function reviewerAt(apiBase: string, apiKey?: string): Config {
  return makeConfig({
    planner: apiSeat({ apiBase: 'http://localhost:11434/v1' }),
    reviewer: apiSeat({ apiBase, ...(apiKey === undefined ? {} : { apiKey }) }),
  });
}

describe('projectRunnerDiscoveryContext', () => {
  it('names the requested seat while the admission role stays planner-tier', () => {
    const config = reviewerAt('http://localhost:11434/v1');
    expect(contextFor(config, 'reviewer')).toMatchObject({ role: 'planner', seatRole: 'reviewer' });
    expect(contextFor(config, 'planner')).toMatchObject({ role: 'planner', seatRole: 'planner' });
    expect(contextFor(config, 'implementer')).toMatchObject({
      role: 'implementer',
      seatRole: 'implementer',
    });
  });

  it('identifies the complete API base URL, not only its origin', () => {
    const base = contextFor(plannerAt('http://localhost:11434/v1'), 'planner');
    const path = contextFor(plannerAt('http://localhost:11434/openai/v1'), 'planner');
    expect(base.endpointOrigin).toBe(path.endpointOrigin);
    expect(base.endpointIdentity).toBeTypeOf('string');
    expect(base.endpointIdentity).not.toBe(path.endpointIdentity);
  });

  it('reads a trailing slash as the same endpoint', () => {
    expect(contextFor(plannerAt('http://localhost:11434/v1/'), 'planner').endpointIdentity).toBe(
      contextFor(plannerAt('http://localhost:11434/v1'), 'planner').endpointIdentity,
    );
  });

  it('leaves a CLI seat without an endpoint identity', () => {
    const context = contextFor(makeConfig(), 'planner');
    expect(context.kind).toBe('cli');
    expect(context.endpointIdentity).toBeUndefined();
  });
});

describe('runnerDiscoveryContextKey', () => {
  it('keeps the reviewer distinct from the planner that shares its admission role', () => {
    const config = reviewerAt('http://localhost:11434/v1');
    const planner = contextFor(config, 'planner');
    const reviewer = contextFor(config, 'reviewer');
    expect(reviewer.role).toBe(planner.role);
    expect(runnerDiscoveryContextKey(reviewer)).not.toBe(runnerDiscoveryContextKey(planner));
  });

  it('keeps the reviewer distinct when the planner holds the review seat', () => {
    const config = plannerAt('http://localhost:11434/v1');
    expect(keyFor(config, 'reviewer')).not.toBe(keyFor(config, 'planner'));
  });

  it.each([
    ['endpoint', 'http://127.0.0.1:1234/v1', undefined],
    ['base path', 'http://localhost:11434/openai/v1', undefined],
    ['auth', 'http://localhost:11434/v1', 'env:REVIEWER_API_KEY'],
  ] as const)('separates a reviewer with a distinct %s', (_axis, apiBase, apiKey) => {
    const shared = keyFor(reviewerAt('http://localhost:11434/v1'), 'reviewer');
    expect(keyFor(reviewerAt(apiBase, apiKey), 'reviewer')).not.toBe(shared);
  });

  it('separates two reviewers that differ only in the environment variable named', () => {
    const first = keyFor(reviewerAt('http://localhost:11434/v1', 'env:FIRST_API_KEY'), 'reviewer');
    const second = keyFor(
      reviewerAt('http://localhost:11434/v1', 'env:SECOND_API_KEY'),
      'reviewer',
    );
    expect(first).not.toBe(second);
  });

  it('answers the same key twice for the same configuration', () => {
    const apiBase = 'http://localhost:11434/v1';
    expect(keyFor(reviewerAt(apiBase, 'env:REVIEWER_API_KEY'), 'reviewer')).toBe(
      keyFor(reviewerAt(apiBase, 'env:REVIEWER_API_KEY'), 'reviewer'),
    );
  });

  it('names an inline credential without carrying it', () => {
    const config = reviewerAt('http://localhost:11434/v1', INLINE_KEY);
    const context = contextFor(config, 'reviewer');
    const key = runnerDiscoveryContextKey(context);
    expect(context.credentialPresent).toBe(true);
    expect(context.credentialDomain?.credentialSource.kind).toBe('inline');
    expect(JSON.stringify(context)).not.toContain(INLINE_KEY);
    expect(key).not.toContain(INLINE_KEY);
    expect(key).not.toContain(encodeURIComponent(INLINE_KEY));
    expect(key).not.toBe(keyFor(reviewerAt('http://localhost:11434/v1'), 'reviewer'));
  });

  it('accepts a legacy context that names neither seat nor endpoint identity', () => {
    const legacy: RunnerDiscoveryContext = {
      role: 'planner',
      kind: 'cli',
      id: 'claude-code',
      authChannel: 'session',
      credentialPresent: false,
      configGeneration: 'config-legacy',
    };
    const key = runnerDiscoveryContextKey(legacy);
    expect(key).toBe(runnerDiscoveryContextKey(legacy));
    expect(key).toBe(runnerDiscoveryContextKey({ ...legacy, seatRole: 'planner' }));
    expect(key).not.toBe(runnerDiscoveryContextKey({ ...legacy, seatRole: 'reviewer' }));
    expect(key).not.toBe(runnerDiscoveryContextKey({ ...legacy, endpointIdentity: 'endpoint-1' }));
  });

  it('excludes cached scope minted before the seat and endpoint were named', () => {
    expect(keyFor(reviewerAt('http://localhost:11434/v1'), 'reviewer')).toContain(
      'runner-evidence-v2',
    );
  });
});
