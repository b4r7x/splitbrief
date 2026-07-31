import { describe, expect, it } from 'vitest';
import {
  getPlannerToolId,
  getRunnerCatalogDisplayName,
  getRunnerDisplayName,
} from './runner-config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';

describe('getPlannerToolId', () => {
  it('returns the tool for cli kind', () => {
    const config: PlannerConfig = { kind: 'cli', tool: 'claude-code' };
    expect(getPlannerToolId(config)).toBe('claude-code');
  });

  it('returns the provider for api kind when it is a valid PlannerToolId', () => {
    const config: PlannerConfig = {
      kind: 'api',
      provider: 'anthropic',
      service: 'anthropic',
      offering: 'payg',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-opus-4-5',
    };
    expect(getPlannerToolId(config)).toBe('anthropic');
  });

  it('falls back to anthropic for api kind with unknown provider', () => {
    const config: PlannerConfig = {
      kind: 'api',
      provider: 'my-custom',
      service: 'my-custom',
      offering: 'payg',
      apiBase: 'http://localhost:9999/v1',
      model: 'my-model',
    };
    expect(getPlannerToolId(config)).toBe('anthropic');
  });

  it('returns shell for shell kind', () => {
    const config: PlannerConfig = { kind: 'shell', command: 'my-planner' };
    expect(getPlannerToolId(config)).toBe('shell');
  });

  it('returns agent (not shell) for agent kind', () => {
    const config: PlannerConfig = { kind: 'agent', command: 'my-agent' };
    expect(getPlannerToolId(config)).toBe('agent');
  });

  it('returns agent-sdk for agent-sdk kind', () => {
    const config: PlannerConfig = { kind: 'agent-sdk' };
    expect(getPlannerToolId(config)).toBe('agent-sdk');
  });
});

describe('getRunnerCatalogDisplayName maps runners to catalog display names', () => {
  it('cli opencode → OpenCode', () => {
    const config: PlannerConfig = { kind: 'cli', tool: 'opencode' };
    expect(getRunnerCatalogDisplayName(config)).toBe('OpenCode');
  });

  it('api anthropic → Anthropic', () => {
    const config: PlannerConfig = {
      kind: 'api',
      provider: 'anthropic',
      service: 'anthropic',
      offering: 'payg',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-opus-4-5',
    };
    expect(getRunnerCatalogDisplayName(config)).toBe('Anthropic');
  });

  it('shell → Custom Shell', () => {
    const config: PlannerConfig = { kind: 'shell', command: 'my-planner' };
    expect(getRunnerCatalogDisplayName(config)).toBe('Custom Shell');
  });

  it('agent → Agent', () => {
    const config: PlannerConfig = { kind: 'agent', command: 'my-agent' };
    expect(getRunnerCatalogDisplayName(config)).toBe('Agent');
  });

  it('agent-sdk → Agent SDK', () => {
    const config: PlannerConfig = { kind: 'agent-sdk' };
    expect(getRunnerCatalogDisplayName(config)).toBe('Agent SDK');
  });
});

describe('getRunnerDisplayName still returns raw lowercase ids', () => {
  it('cli opencode → opencode', () => {
    const config: PlannerConfig = { kind: 'cli', tool: 'opencode' };
    expect(getRunnerDisplayName(config)).toBe('opencode');
  });
});
