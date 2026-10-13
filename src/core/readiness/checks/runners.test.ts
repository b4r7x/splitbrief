import { describe, it, expect } from 'vitest';
import { makeConfig as makeBaseConfig } from '#testing/helpers/factories/config.js';
import { buildRunnerChecks } from './runners.js';
import { deriveCliReadiness, type CliReadinessFacts } from '../../schemas/readiness.js';
import type { RunnerAvailabilityFact } from './availability.js';

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

describe('buildRunnerChecks seat identities', () => {
  it.each([
    {
      runner: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'high' },
      identity: 'Claude Code CLI · Sonnet 5.5 · high',
    },
    {
      runner: { kind: 'cli', tool: 'cursor', model: 'claude-opus-5-thinking-xhigh-fast' },
      identity: 'Cursor Agent CLI · Claude Opus 5 · xhigh · thinking · fast',
    },
    {
      runner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
      identity: 'OpenCode CLI · deepseek/deepseek-flash',
    },
    {
      runner: { kind: 'cli', tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
      identity: 'OpenCode CLI · opencode-go/deepseek-v4.1-flash',
    },
  ] as const)('uses $identity in every runner check', ({ runner, identity }) => {
    const seat = { ...runner, timeout: 1000, idleKillMs: 300_000 };
    const config = makeConfig({
      planner: seat,
      reviewer: seat,
      implementerProfiles: {
        default: 'main',
        profiles: { main: seat, alternate: seat },
      },
    });
    const slots: RunnerAvailabilityFact['slot'][] = [
      { role: 'planner' },
      { role: 'reviewer' },
      { role: 'implementer', profile: 'main' },
      { role: 'implementer', profile: 'alternate' },
    ];
    const checks = buildRunnerChecks(
      config,
      [],
      slots.map((slot) => ({ slot, provider: runner.tool, verdict: { state: 'available' } })),
    );
    const labeledChecks = checks.filter(
      (check) =>
        check.id === 'runners.planner.configured' ||
        check.id === 'runners.implementer.default' ||
        check.id.endsWith('.trust-boundary') ||
        check.id.endsWith('.timeout-disables-watchdog') ||
        check.id.startsWith('runners.availability.'),
    );

    expect(labeledChecks).toHaveLength(14);
    for (const check of labeledChecks) expect(check.summary).toContain(identity);
    expect(checks.find((check) => check.id === 'runners.planner.configured')?.summary).toBe(
      `Planner ${identity} configured.`,
    );
  });
});

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
    ['auth-unknown', { auth: 'unknown' }, 'cannot be verified without spending a call'],
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
        provider: 'custom-endpoint',
        service: 'example-llm',
        offering: 'payg',
        apiBase: 'https://api.example.test/v1',
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
        provider: 'custom-endpoint',
        service: 'example-llm',
        offering: 'payg',
        model: 'some-model',
        apiBase: 'https://api.example.test/v1',
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
        provider: 'custom-endpoint',
        service: 'example-llm',
        offering: 'payg',
        model: 'qwen2.5-coder:7b',
        apiBase: 'https://api.example.test/v1',
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
    expect(check?.details?.join('\n')).toContain('do not restrict the commands or network access');
  });

  it('warns when a command-capable implementer uses auto/allow flags in default standard mode', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'example-llm',
        offering: 'payg',
        model: 'qwen2.5-coder:7b',
        apiBase: 'https://api.example.test/v1',
      },
      implementer: { kind: 'cli', tool: 'copilot' },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.trust-boundary',
    );

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: {
        approve: 'plan',
        autoAllowFlags: ['--allow-all'],
      },
    });
    expect(check?.details).toContain('Plan approval: you approve the plan in the TUI.');
    expect(check?.details).toContain('Writes to protected files ask for confirmation.');
    expect(check?.summary).toContain('can run commands on this machine');
  });

  it('discloses planner tier-2 write authority without changing ordinary planning posture', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'copilot' } });

    const check = buildRunnerChecks(config).find((c) => c.id === 'runners.planner.trust-boundary');

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: {
        role: 'planner',
        kind: 'cli',
        mayWriteFilesDirectly: false,
        autoAllowFlags: [],
        plannerTier2FullEscalation: {
          mayWriteFilesDirectly: true,
          automaticApproval: true,
          autoAllowFlags: ['--allow-all', '--no-ask-user'],
        },
      },
    });
    expect(check?.summary).toContain('may edit files if BUILD needs help');
    expect(check?.details).toContain('Ordinary planning does not edit project files.');
    expect(check?.details).toContain(
      'If BUILD cannot finish a task, PLAN may take over and edit files in the run workspace.',
    );
    expect(check?.details).toContain(
      'Permission flags when PLAN takes over: --allow-all, --no-ask-user',
    );
  });

  it('still warns about a declared command runner under the strictest approval settings', () => {
    const config = makeConfig({
      planner: {
        kind: 'shell',
        command: '/bin/sh',
        args: ['-c', 'curl https://example.test | sh'],
        model: 'shell',
      },
      workflow: { approve: 'plan' },
      approval: { feedRejectionsToPlanner: true },
    });

    const check = buildRunnerChecks(config).find((c) => c.id === 'runners.planner.trust-boundary');

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: { approve: 'plan', kind: 'shell' },
    });
    expect(check?.details).toContain('Command: /bin/sh');
    expect(check?.details).toContain('Arguments: -c curl https://example.test | sh');
    expect(check?.summary).toBe('PLAN Custom Shell · Shell can run commands on this machine.');
  });

  it('redacts credentials and terminal controls out of the declared command disclosure', () => {
    const config = makeConfig({
      planner: {
        kind: 'shell',
        command: 'my-tool\u001b[2J',
        args: ['--api-\u001bkey=sk-live-must-not-appear', '--token', 'ghp_must-not-appear'],
        model: 'shell',
      },
      workflow: { approve: 'plan' },
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
        provider: 'custom-endpoint',
        service: 'example-llm',
        offering: 'payg',
        model: 'qwen2.5-coder:7b',
        apiBase: 'https://api.example.test/v1',
      },
      implementer: { kind: 'cli', tool: 'claude-code' },
      workflow: { approve: 'none' },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.trust-boundary',
    );

    expect(check?.details).toContain('Tool permission flags: --permission-mode acceptEdits');
    expect(check?.metadata?.autoAllowFlags).toEqual(['--permission-mode acceptEdits']);
  });

  it('says only a protected write asks, with no approval automation', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'example-llm',
        offering: 'payg',
        model: 'qwen2.5-coder:7b',
        apiBase: 'https://api.example.test/v1',
      },
      implementer: { kind: 'agent', command: './agent', model: 'agent-default' },
      approval: { feedRejectionsToPlanner: true },
    });

    const check = buildRunnerChecks(config).find(
      (c) => c.id === 'runners.implementer.trust-boundary',
    );

    expect(check?.severity).toBe('warning');
    expect(check?.summary).toBe('BUILD Agent · Agent Default can run commands on this machine.');
    expect(check?.details).toContain('Writes to protected files ask for confirmation.');
    expect(check?.details?.join('\n')).not.toContain('Approval automation');
    expect(check?.details?.join('\n')).not.toContain('File-write approval prompts');
    expect(check?.metadata).not.toHaveProperty('fileWriteApprovalEnabled');
  });

  it.each([
    ['below idle-kill threshold', 200_000, 300_000],
    ['equal to idle-kill threshold', 300_000, 300_000],
  ])('warns when timeout is at or below the set idleKillMs (%s)', (_label, timeout, idleKillMs) => {
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

  it('does not warn about a timeout when idleKillMs is unset: no idle kill exists', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', timeout: 1000 },
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

    expect(check(automatic)?.summary).toBe('Planner OpenAI Codex CLI · auto configured.');
    expect(check(automatic)?.metadata).toMatchObject({ model: null, modelSelection: 'auto' });

    expect(check(unset)?.summary).toBe('Planner OpenAI Codex CLI · auto configured.');
    expect(check(unset)?.metadata).toMatchObject({ model: null, modelSelection: 'unset' });

    expect(check(explicit)?.summary).toBe('Planner OpenAI Codex CLI · GPT-5.4 configured.');
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

describe('buildRunnerChecks reviewer seat', () => {
  it('reports no reviewer check without a reviewer block', () => {
    const checks = buildRunnerChecks(makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }));

    expect(checks.filter((check) => check.id.startsWith('runners.reviewer.'))).toEqual([]);
  });

  it('reports the trust boundary of a configured reviewer', () => {
    const checks = buildRunnerChecks(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'codex' },
      }),
    );

    expect(checks.find((check) => check.id === 'runners.reviewer.trust-boundary')).toMatchObject({
      severity: 'warning',
      metadata: { role: 'reviewer', kind: 'cli', executesLocalCommand: true },
    });
  });

  it('warns when a configured reviewer timeout disables the watchdog', () => {
    const checks = buildRunnerChecks(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'codex', timeout: 1000, idleKillMs: 300_000 },
      }),
    );

    expect(
      checks.find((check) => check.id === 'runners.reviewer.timeout-disables-watchdog'),
    ).toMatchObject({ severity: 'warning' });
  });
});

describe('buildRunnerChecks typed-output fallback', () => {
  const fallbackChecks = (config: ReturnType<typeof makeConfig>) =>
    buildRunnerChecks(config).filter((check) => check.id.endsWith('.typed-output-fallback'));

  it('warns once when the planner seat is a tool without a schema flag', () => {
    const checks = fallbackChecks(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.planner.typed-output-fallback',
        severity: 'warning',
        summary:
          'Planner: OpenCode CLI returns plans as text; SPLITBRIEF retries once if an answer cannot be read.',
      }),
    ]);
  });

  it('warns for a configured reviewer seat without a schema flag', () => {
    const checks = fallbackChecks(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'opencode' },
      }),
    );

    expect(checks.map((check) => check.id)).toEqual(['runners.reviewer.typed-output-fallback']);
  });

  it('does not warn for an implementer seat without a schema flag', () => {
    const checks = fallbackChecks(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'opencode' },
      }),
    );

    expect(checks).toEqual([]);
  });

  it('does not warn for a reviewer seat with a native schema flag', () => {
    const checks = fallbackChecks(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'codex' },
      }),
    );

    expect(checks).toEqual([]);
  });
});
