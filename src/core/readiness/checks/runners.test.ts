import { describe, it, expect } from 'vitest';
import { makeConfig as makeBaseConfig } from '#testing/helpers/factories/config.js';
import { buildRunnerChecks } from './runners.js';
import { deriveCliReadiness, type CliReadinessFacts } from '../../schemas/readiness.js';

function makeConfig(overrides: Parameters<typeof makeBaseConfig>[0] = {}) {
  const implementer = overrides.implementer;
  return makeBaseConfig({
    ...overrides,
    implementer:
      implementer?.kind !== undefined && implementer.kind !== 'api'
        ? implementer
        : { service: 'ollama', offering: 'local', ...implementer },
  });
}

function cliReadiness(overrides: Partial<CliReadinessFacts> = {}) {
  return deriveCliReadiness({
    tool: 'claude-code',
    enabled: true,
    installation: 'installed',
    executable: {
      path: '/usr/local/bin/claude',
      fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
    },
    trust: 'trusted',
    installedVersion: '2.0.0',
    testedVersion: '2.0.0',
    compatibility: 'compatible',
    auth: 'authenticated',
    probedAt: 1,
    ...overrides,
  });
}

function availabilityDetails(config: ReturnType<typeof makeConfig>): string[] {
  const check = buildRunnerChecks(config).find((c) => c.id === 'runners.availability');
  return check?.details ?? [];
}

describe('buildRunnerChecks availability guidance', () => {
  it('blocks a selected CLI when no canonical probe result is available', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const check = buildRunnerChecks(config, []).find(
      (candidate) => candidate.id === 'runners.cli.claude-code.readiness',
    );

    expect(check).toMatchObject({
      severity: 'blocker',
      metadata: {
        tool: 'claude-code',
        status: 'unverified',
        trust: 'not-checked',
        auth: 'not-checked',
        executablePath: null,
      },
    });
  });

  it('blocks a selected CLI that requires authentication but is unauthenticated', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const check = buildRunnerChecks(config, [
      cliReadiness({ auth: 'unauthenticated', authChannel: 'session' }),
    ]).find((candidate) => candidate.id === 'runners.cli.claude-code.readiness');

    expect(check).toMatchObject({
      severity: 'blocker',
      metadata: {
        status: 'unauthenticated',
        installation: 'installed',
        trust: 'trusted',
        compatibility: 'compatible',
        auth: 'unauthenticated',
      },
    });
    // The staged runner reads the same credential store the host signs in to,
    // so signing in is the remedy — not a switch to metered billing.
    expect(check?.fix).toContain('Sign in to claude-code');
    expect(check?.fix).not.toContain('ANTHROPIC_API_KEY');
  });

  it('warns without claiming readiness when selected CLI authentication is unknown', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const check = buildRunnerChecks(config, [cliReadiness({ auth: 'unknown' })]).find(
      (candidate) => candidate.id === 'runners.cli.claude-code.readiness',
    );

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: { status: 'unverified', auth: 'unknown' },
    });
    expect(check?.summary).not.toContain('is installed, trusted, compatible, and authenticated');
  });

  it('does not claim authentication when the selected CLI does not require it', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const check = buildRunnerChecks(config, [cliReadiness({ auth: 'not-required' })]).find(
      (candidate) => candidate.id === 'runners.cli.claude-code.readiness',
    );

    expect(check).toMatchObject({ severity: 'ok', metadata: { auth: 'not-required' } });
    expect(check?.summary).toContain('does not require authentication');
  });

  it.each([
    ['missing-binary', { installation: 'unavailable', executable: null }, 'Install claude-code'],
    ['untrusted-path', { trust: 'untrusted' }, 'Trust the exact'],
    ['incompatible-version', { compatibility: 'incompatible' }, 'Install the tested'],
    [
      'unauthenticated',
      { auth: 'unauthenticated', authChannel: 'api-key' },
      'Export ANTHROPIC_API_KEY',
    ],
    ['auth-unknown', { auth: 'unknown' }, 'Verify claude-code authentication'],
  ] as const)('publishes %s as a structured diagnostic state', (stateId, overrides, fix) => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const check = buildRunnerChecks(config, [cliReadiness(overrides)]).find(
      (candidate) => candidate.id === 'runners.cli.claude-code.readiness',
    );

    expect(check?.diagnosticState).toBe(stateId);
    expect(check?.fix).toContain(fix);
  });

  it('publishes no diagnostic state for ready, disabled, or version-unverified CLIs', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    for (const result of [
      cliReadiness(),
      cliReadiness({ enabled: false }),
      cliReadiness({ compatibility: 'unverified' }),
    ]) {
      const check = buildRunnerChecks(config, [result]).find(
        (candidate) => candidate.id === 'runners.cli.claude-code.readiness',
      );
      expect(check?.diagnosticState).toBeUndefined();
    }
  });

  it('redacts trusted executable paths from public readiness metadata', () => {
    const executablePath = '/Users/private-user/project/bin/claude';
    const result = cliReadiness({
      executable: {
        path: executablePath,
        fingerprint: { dev: 9, ino: 10, size: 11, mtimeMs: 12 },
      },
    });
    const check = buildRunnerChecks(makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }), [
      result,
    ]).find((candidate) => candidate.id === 'runners.cli.claude-code.readiness');

    expect(check?.metadata?.executablePath).toBe('[redacted executable path]');
    expect(JSON.stringify(check)).not.toContain(executablePath);
    expect(result.executable?.path).toBe(executablePath);
  });

  it('ignores readiness results for CLIs that are not configured', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        apiBase: 'https://openrouter.ai/api/v1',
        model: 'qwen2.5-coder:7b',
      },
    });

    const check = buildRunnerChecks(config, [
      cliReadiness({ installation: 'unavailable', executable: null }),
    ]).find((candidate) => candidate.id === 'runners.cli.claude-code.readiness');

    expect(check).toBeUndefined();
  });

  it('does not claim provider availability for an API planner', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        model: 'some-model',
        apiBase: 'https://openrouter.ai/api/v1',
      },
    });

    const details = availabilityDetails(config);
    expect(details).toContain('Readiness makes no provider or network availability claim.');
  });

  it('uses the canonical CLI check instead of generic availability guidance', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const checks = buildRunnerChecks(config);

    expect(checks.find((check) => check.id === 'runners.availability')?.summary).toBe(
      'Provider availability was not probed.',
    );
    expect(checks.find((check) => check.id === 'runners.cli.claude-code.readiness')?.severity).toBe(
      'blocker',
    );
  });

  it('warns when a command-capable implementer runs with approval auto mode', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        model: 'qwen2.5-coder:7b',
        apiBase: 'https://openrouter.ai/api/v1',
      },
      implementer: { kind: 'cli', tool: 'copilot' },
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
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        model: 'qwen2.5-coder:7b',
        apiBase: 'https://openrouter.ai/api/v1',
      },
      implementer: { kind: 'cli', tool: 'copilot' },
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

  it('still warns about a declared command runner under the strictest approval settings', () => {
    const config = makeConfig({
      planner: {
        kind: 'shell',
        command: '/bin/sh',
        args: ['-c', 'curl https://example.test | sh'],
        model: 'shell',
      },
      workflow: { approve: 'all' },
      approval: { enabled: true, feedRejectionsToPlanner: true },
    });

    const check = buildRunnerChecks(config).find((c) => c.id === 'runners.planner.trust-boundary');

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: { approve: 'all', kind: 'shell' },
    });
    expect(check?.details).toContain('Command: /bin/sh');
    expect(check?.details).toContain('Arguments: -c curl https://example.test | sh');
    expect(check?.summary).toBe('Planner shell (shell) can execute commands on this machine.');
  });

  it('redacts credentials and terminal controls out of the declared command disclosure', () => {
    const config = makeConfig({
      planner: {
        kind: 'shell',
        command: 'my-tool\u001b[2J',
        args: ['--api-\u001bkey=sk-live-must-not-appear', '--token', 'ghp_must-not-appear'],
        model: 'shell',
      },
      workflow: { approve: 'all' },
    });

    const details = (
      buildRunnerChecks(config).find((c) => c.id === 'runners.planner.trust-boundary')?.details ??
      []
    ).join('\n');

    expect(details).toContain('Command: my-tool');
    expect(details).not.toContain('\u001b');
    expect(details).not.toContain('sk-live-must-not-appear');
    expect(details).not.toContain('ghp_must-not-appear');
  });

  it('includes claude-code accept-edits metadata in trust warnings', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        model: 'qwen2.5-coder:7b',
        apiBase: 'https://openrouter.ai/api/v1',
      },
      implementer: { kind: 'cli', tool: 'claude-code' },
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
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        model: 'qwen2.5-coder:7b',
        apiBase: 'https://openrouter.ai/api/v1',
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

  it.each([
    ['below idle-kill threshold', 200_000, 300_000],
    ['equal to idle-kill threshold', 300_000, 300_000],
  ])('warns when timeout is at or below the effective idleKillMs (%s)', (_label, timeout, idleKillMs) => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        timeout,
        idleKillMs,
      },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.timeout-disables-watchdog',
    );

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: { timeout, idleKillMs },
    });
  });

  it('does not warn when timeout leaves room above the idle-kill threshold', () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        timeout: 400_000,
        idleKillMs: 300_000,
      },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.timeout-disables-watchdog',
    );

    expect(check).toBeUndefined();
  });

  it('distinguishes automatic CLI selection from an unset model', () => {
    const automatic = makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'auto' } });
    const unset = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const explicit = makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' } });

    const check = (config: ReturnType<typeof makeConfig>) =>
      buildRunnerChecks(config).find((c) => c.id === 'runners.planner.configured');

    expect(check(automatic)?.summary).toContain('codex (auto)');
    expect(check(automatic)?.metadata).toMatchObject({ model: null, modelSelection: 'auto' });

    expect(check(unset)?.summary).not.toContain('(');
    expect(check(unset)?.metadata).toMatchObject({ model: null, modelSelection: 'unset' });

    expect(check(explicit)?.summary).toContain('codex (gpt-5.4)');
    expect(check(explicit)?.metadata).toMatchObject({
      model: 'gpt-5.4',
      modelSelection: 'explicit',
    });
  });

  it('readiness summaries capitalize roles via formatRoleLabel', () => {
    const config = makeConfig();

    const check = buildRunnerChecks(config).find((c) => c.id === 'runners.planner.configured');

    expect(check?.summary).toMatch(/^Planner /);
  });
});
