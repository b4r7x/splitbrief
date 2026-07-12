import { describe, it, expect } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { buildRunnerChecks } from './runners.js';

function availabilityDetails(config: ReturnType<typeof makeConfig>): string[] {
  const check = buildRunnerChecks(config).find((c) => c.id === 'runners.availability');
  return check?.details ?? [];
}

describe('buildRunnerChecks availability guidance', () => {
  it('points at the API key, endpoint, and model for an api planner', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
        model: 'some-model',
        apiBase: 'https://openrouter.ai/api/v1',
      },
    });

    const details = availabilityDetails(config);
    expect(details.some((d) => d.includes('API key, endpoint, and model'))).toBe(true);
    expect(details.some((d) => d.includes('runner CLI'))).toBe(false);
  });

  it('points at the runner CLI for a cli planner', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const details = availabilityDetails(config);
    expect(details.some((d) => d.includes('runner CLI'))).toBe(true);
    expect(details.some((d) => d.includes('API key, endpoint, and model'))).toBe(false);
  });

  it('warns when a command-capable implementer runs with approval auto mode', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        apiBase: 'http://localhost:11434/v1',
      },
      implementer: { kind: 'cli', tool: 'copilot', model: 'auto' },
      workflow: { approve: 'none' },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.trust-boundary',
    );

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: {
        role: 'implementer',
        kind: 'cli',
        executesLocalCommand: true,
        mayUseNetwork: true,
        mayWriteFilesDirectly: true,
        autoAllowFlags: ['--allow-all'],
      },
    });
    expect(check?.details?.join('\n')).toContain('not sandbox shell commands or network access');
  });

  it('warns when a command-capable implementer uses auto/allow flags in default standard mode', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        apiBase: 'http://localhost:11434/v1',
      },
      implementer: { kind: 'cli', tool: 'copilot', model: 'auto' },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.trust-boundary',
    );

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: {
        approve: 'spec',
        fileWriteApprovalEnabled: true,
        autoAllowFlags: ['--allow-all'],
      },
    });
    expect(check?.details).toContain('Spec/plan approval level: spec.');
    expect(check?.details).toContain('File-write approval prompts: enabled.');
    expect(check?.summary).toContain('uses auto/allow runner flags');
  });

  it('includes claude-code accept-edits metadata in trust warnings', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        apiBase: 'http://localhost:11434/v1',
      },
      implementer: { kind: 'cli', tool: 'claude-code', model: 'auto' },
      workflow: { approve: 'none' },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.trust-boundary',
    );

    expect(check?.details).toContain('Runner auto/allow flags: --permission-mode acceptEdits');
    expect(check?.metadata?.autoAllowFlags).toEqual(['--permission-mode acceptEdits']);
  });

  it('warns when command-capable runners run with file-write approvals disabled', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        apiBase: 'http://localhost:11434/v1',
      },
      implementer: { kind: 'agent', command: './agent', model: 'agent-default' },
      approval: { enabled: false, feedRejectionsToPlanner: true },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.trust-boundary',
    );

    expect(check?.severity).toBe('warning');
    expect(check?.details?.join('\n')).toContain('file-write approval prompts are disabled');
    expect(check?.metadata?.fileWriteApprovalEnabled).toBe(false);
  });

  it('warns when timeout is at or below the effective idleKillMs', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'auto', timeout: 100_000 },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.timeout-disables-watchdog',
    );

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: { timeout: 100_000, idleKillMs: 1_800_000 },
    });
  });

  it('does not warn when timeout leaves room above the idle-kill threshold', () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'auto',
        timeout: 400_000,
        idleKillMs: 300_000,
      },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.timeout-disables-watchdog',
    );

    expect(check).toBeUndefined();
  });

  it('readiness summaries capitalize roles via formatRoleLabel', () => {
    const config = makeConfig();

    const check = buildRunnerChecks(config).find((c) => c.id === 'runners.planner.configured');

    expect(check?.summary).toMatch(/^Planner /);
  });
});
