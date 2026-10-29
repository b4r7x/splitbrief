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
  const check = buildRunnerChecks({ config }).find((c) => c.id === 'runners.availability');
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
      identity: 'OpenCode CLI · DeepSeek V4.1 Flash · via deepseek',
    },
    {
      runner: { kind: 'cli', tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
      identity: 'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go',
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
    const checks = buildRunnerChecks({
      config,
      cliReadiness: [],
      availability: slots.map((slot) => ({
        slot,
        provider: runner.tool,
        verdict: { state: 'available' },
      })),
    });
    const labeledChecks = checks.filter(
      (check) =>
        check.id === 'runners.planner.configured' ||
        check.id === 'runners.reviewer.configured' ||
        check.id === 'runners.implementer.default' ||
        check.id.endsWith('.timeout-disables-watchdog') ||
        check.id.startsWith('runners.availability.'),
    );

    expect(labeledChecks).toHaveLength(11);
    for (const check of labeledChecks) expect(check.summary.split(identity)).toHaveLength(2);
    expect(checks.find((check) => check.id === 'runners.planner.configured')?.summary).toBe(
      `PLAN ${identity} configured.`,
    );
    expect(checks.find((check) => check.id === 'runners.reviewer.configured')?.summary).toBe(
      `REVIEW ${identity} configured.`,
    );
    expect(checks.find((check) => check.id === 'runners.implementer.default')?.summary).toBe(
      `BUILD (main) ${identity} configured.`,
    );
  });
});

describe('buildRunnerChecks catalog labels', () => {
  it('names every seat by the catalog label the crew surfaces show', () => {
    const seat = {
      kind: 'cli',
      tool: 'codex',
      model: 'gpt-6-luna',
      timeout: 1000,
      idleKillMs: 300_000,
    } as const;
    const config = makeConfig({
      planner: seat,
      reviewer: seat,
      implementerProfiles: { default: 'main', profiles: { main: seat, alternate: seat } },
    });
    const roles = new Set<string>();
    const checks = buildRunnerChecks({
      config,
      cliReadiness: [],
      seatDisplayName: (runner, role) => {
        roles.add(role);
        return runner.kind === 'cli' && runner.model === 'gpt-6-luna' ? 'GPT-6-Luna' : undefined;
      },
    });
    const labeled = checks.filter(
      (check) =>
        check.id === 'runners.planner.configured' ||
        check.id === 'runners.reviewer.configured' ||
        check.id === 'runners.implementer.default' ||
        check.id.endsWith('.timeout-disables-watchdog'),
    );

    expect(labeled).toHaveLength(7);
    for (const check of labeled) {
      expect(check.summary).toContain('OpenAI Codex CLI · GPT-6-Luna');
      expect(check.summary).not.toContain('GPT-6 Luna');
    }
    expect([...roles].sort()).toEqual(['implementer', 'planner', 'reviewer']);
  });
});

describe('buildRunnerChecks availability guidance', () => {
  it('blocks a selected CLI when no canonical probe result is available', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const check = buildRunnerChecks({ config, cliReadiness: [] }).find(
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

    const check = buildRunnerChecks({
      config,
      cliReadiness: [cliReadiness({ auth: 'unauthenticated', authChannel: 'session' })],
    }).find((candidate) => candidate.id === 'runners.cli.claude-code.readiness');

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
    expect(check?.fix).toContain('Sign in to Claude Code CLI,');
    expect(check?.fix).not.toContain('ANTHROPIC_API_KEY');
  });

  it('names a Codex sign-in kept in the system keyring in the summary and the fix', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });

    const check = buildRunnerChecks({
      config,
      cliReadiness: [
        cliReadiness({
          tool: 'codex',
          executable: {
            path: '/usr/local/bin/codex',
            fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
          },
          auth: 'keyring',
          authChannel: 'session',
        }),
      ],
    }).find((candidate) => candidate.id === 'runners.cli.codex.readiness');

    expect(check).toMatchObject({
      severity: 'blocker',
      summary:
        'OpenAI Codex CLI keeps its sign-in in the system keyring, which a run cannot reach.',
      fix: 'Set cli_auth_credentials_store = "file" in config.toml and run codex login again, or use OPENAI_API_KEY, then run `splitbrief doctor` again.',
    });
  });

  describe('a signed-in tool on a model route with no credential', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' },
    });
    const opencode = (providerAuth: CliReadinessFacts['providerAuth']) =>
      cliReadiness({
        tool: 'opencode',
        authChannel: 'provider-dependent',
        auth: 'authenticated',
        providerAuth,
      });
    // The saved model list serves OpenCode Go only, so it says nothing for ollama-cloud.
    const goOnly = [{ tool: 'opencode' as const, models: [{ id: 'opencode-go/kimi-k3' }] }];
    const routeCheck = (
      providerAuth: CliReadinessFacts['providerAuth'],
      cliCatalogs: Parameters<typeof buildRunnerChecks>[0]['cliCatalogs'] = goOnly,
    ) =>
      buildRunnerChecks({ config, cliReadiness: [opencode(providerAuth)], cliCatalogs }).find(
        (candidate) => candidate.id.startsWith('runners.route.'),
      );

    it('warns that the route has no credential and names its sign-in step', () => {
      expect(
        routeCheck({ kind: 'read', facts: [{ provider: 'OpenCode Go', source: 'stored' }] }),
      ).toMatchObject({
        id: 'runners.route.implementer.default',
        severity: 'warning',
        summary: 'BUILD: OpenCode CLI has no credential for ollama-cloud.',
        fix: 'Run `opencode auth login ollama-cloud`, or choose another model in Settings > Crew > BUILD.',
      });
    });

    const storesNoCredential = cliReadiness({
      tool: 'opencode',
      authChannel: 'provider-dependent',
      auth: 'unauthenticated',
      providerAuth: { kind: 'empty' },
    });

    it('keeps the sign-in blocker of a tool that stores no credential when its model list does not serve the route', () => {
      const checks = buildRunnerChecks({
        config,
        cliReadiness: [storesNoCredential],
        cliCatalogs: [{ tool: 'opencode', models: [{ id: 'opencode-go/kimi-k3' }] }],
      });
      expect(checks.find((candidate) => candidate.id.startsWith('runners.route.'))).toBeUndefined();
      expect(
        checks.find((candidate) => candidate.id === 'runners.cli.opencode.readiness'),
      ).toMatchObject({
        severity: 'blocker',
        runnerCause: { cause: 'unauthenticated', seats: ['BUILD'] },
      });
      expect(checks.map((check) => check.summary).join('\n')).not.toMatch(/available/i);
    });

    it('lifts the sign-in blocker for a route its model list serves, without claiming a sign-in', () => {
      const local = makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', model: 'ollama/llama3' },
      });
      const checks = buildRunnerChecks({
        config: local,
        cliReadiness: [storesNoCredential],
        cliCatalogs: [{ tool: 'opencode', models: [{ id: 'ollama/llama3' }] }],
      });
      expect(
        checks.filter(
          (check) => check.severity === 'blocker' && check.metadata?.tool !== 'claude-code',
        ),
      ).toEqual([]);
      expect(checks.find((candidate) => candidate.id.startsWith('runners.route.'))).toBeUndefined();
      const tool = checks.find((candidate) => candidate.id === 'runners.cli.opencode.readiness');
      expect(tool).toMatchObject({
        severity: 'ok',
        summary:
          'OpenCode CLI is installed, trusted, compatible, and stores no credential; it calls the providers set up in its config.',
      });
      expect(tool?.summary).not.toContain('signed in');
      expect(tool?.fix).toBeUndefined();
      expect(tool?.runnerCause).toBeUndefined();
    });

    it('names only the seats whose route its model list does not serve in the sign-in blocker', () => {
      const mixed = makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'ollama/llama3' },
        implementer: { kind: 'cli', tool: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' },
      });
      const checks = buildRunnerChecks({
        config: mixed,
        cliReadiness: [storesNoCredential],
        cliCatalogs: [{ tool: 'opencode', models: [{ id: 'ollama/llama3' }] }],
      });
      expect(
        checks.find((candidate) => candidate.id === 'runners.cli.opencode.readiness'),
      ).toMatchObject({
        severity: 'blocker',
        summary: 'OpenCode CLI is not signed in.',
        runnerCause: { cause: 'unauthenticated', seats: ['BUILD'] },
      });
    });

    it('claims nothing when the route is signed in or the listing is unreadable', () => {
      expect(
        routeCheck({
          kind: 'read',
          facts: [{ provider: 'Ollama Cloud', source: 'env', envVar: 'OLLAMA_API_KEY' }],
        }),
      ).toBeUndefined();
      expect(routeCheck({ kind: 'unreadable', reason: 'timeout' })).toBeUndefined();
    });

    it('claims nothing when the project has no saved model list', () => {
      expect(
        routeCheck({ kind: 'read', facts: [{ provider: 'OpenCode Go', source: 'stored' }] }, []),
      ).toBeUndefined();
    });

    it("claims nothing when the tool's saved model list serves another model of the route's provider", () => {
      expect(
        routeCheck({ kind: 'read', facts: [{ provider: 'OpenCode Go', source: 'stored' }] }, [
          { tool: 'opencode', models: [{ id: 'ollama-cloud/glm-5' }] },
        ]),
      ).toBeUndefined();
    });

    it("claims nothing when the tool's saved model list serves the route", () => {
      const check = buildRunnerChecks({
        config,
        cliReadiness: [
          opencode({ kind: 'read', facts: [{ provider: 'OpenCode Go', source: 'stored' }] }),
        ],
        cliCatalogs: [{ tool: 'opencode', models: [{ id: 'ollama-cloud/deepseek-v4.1-flash' }] }],
      }).find((candidate) => candidate.id.startsWith('runners.route.'));
      expect(check).toBeUndefined();
    });
  });

  describe('the tool row of a tool whose seat route has no credential', () => {
    const DEEPSEEK = { provider: 'DeepSeek', source: 'stored' } as const;
    // A gateway model of each tool, which needs the tool's own sign-in; DeepSeek does not serve it.
    const routes = [
      {
        tool: 'opencode',
        name: 'OpenCode CLI',
        model: 'opencode/big-pickle',
        provider: 'opencode',
      },
      { tool: 'kilo-code', name: 'Kilo Code CLI', model: 'kilo/openrouter/free', provider: 'kilo' },
    ] as const;
    const seats = [
      { word: 'PLAN', key: 'planner' },
      { word: 'BUILD', key: 'implementer' },
      { word: 'REVIEW', key: 'reviewer' },
    ] as const;
    const signedIn = (tool: (typeof routes)[number]['tool']) =>
      cliReadiness({
        tool,
        authChannel: 'provider-dependent',
        auth: 'authenticated',
        providerAuth: { kind: 'read', facts: [DEEPSEEK] },
      });
    const checksFor = (route: (typeof routes)[number], config: ReturnType<typeof makeConfig>) =>
      buildRunnerChecks({
        config,
        cliReadiness: [cliReadiness(), signedIn(route.tool)],
        cliCatalogs: [{ tool: route.tool, models: [{ id: route.model }, { id: 'ollama/llama3' }] }],
      });
    const summaryOf = (checks: ReturnType<typeof buildRunnerChecks>, id: string) =>
      checks.find((check) => check.id === id)?.summary;

    for (const route of routes) {
      it.each(seats)(
        `leaves the credential of $word on ${route.tool} to its route row`,
        ({ word, key }) => {
          const checks = checksFor(
            route,
            makeConfig({
              planner: { kind: 'cli', tool: 'claude-code' },
              [key]: { kind: 'cli', tool: route.tool, model: route.model },
            }),
          );
          expect(summaryOf(checks, `runners.cli.${route.tool}.readiness`)).toBe(
            `${route.name} is installed, trusted and compatible.`,
          );
          expect(checks.find((check) => check.id.startsWith('runners.route.'))?.summary).toBe(
            `${word}: ${route.name} has no credential for ${route.provider}.`,
          );
        },
      );

      it.each(seats)(
        `keeps signed in for ${route.tool} when only the fallback of $word routes to it with no credential`,
        ({ key }) => {
          const seat = { kind: 'cli', tool: 'claude-code' } as const;
          const checks = checksFor(
            route,
            makeConfig({
              planner: seat,
              implementer: { kind: 'cli', tool: route.tool, model: 'ollama/llama3' },
              reviewer: seat,
              [key]: {
                ...(key === 'implementer'
                  ? { kind: 'cli', tool: route.tool, model: 'ollama/llama3' }
                  : seat),
                fallback: { tool: route.tool, model: route.model },
              },
            }),
          );
          expect(checks.find((check) => check.id.startsWith('runners.route.'))).toBeUndefined();
          expect(summaryOf(checks, `runners.cli.${route.tool}.readiness`)).toBe(
            `${route.name} is installed, trusted, compatible, and signed in.`,
          );
        },
      );
    }

    it('keeps signed in for a tool with no route check', () => {
      const checks = buildRunnerChecks({
        config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
        cliReadiness: [cliReadiness()],
      });
      expect(summaryOf(checks, 'runners.cli.claude-code.readiness')).toBe(
        'Claude Code CLI is installed, trusted, compatible, and signed in.',
      );
    });
  });

  it('warns without claiming readiness when selected CLI authentication is unknown', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const check = buildRunnerChecks({
      config,
      cliReadiness: [cliReadiness({ auth: 'unknown' })],
    }).find((candidate) => candidate.id === 'runners.cli.claude-code.readiness');

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: { status: 'unverified', auth: 'unknown' },
    });
    expect(check?.summary).not.toContain('is installed, trusted, compatible, and signed in');
  });

  it('does not claim authentication when the selected CLI does not require it', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const check = buildRunnerChecks({
      config,
      cliReadiness: [cliReadiness({ auth: 'not-required' })],
    }).find((candidate) => candidate.id === 'runners.cli.claude-code.readiness');

    expect(check).toMatchObject({ severity: 'ok', metadata: { auth: 'not-required' } });
    expect(check?.summary).toContain('does not require authentication');
  });

  it.each([
    [
      'missing-binary',
      { installation: 'unavailable', executable: null },
      'Install Claude Code CLI, then',
    ],
    ['untrusted-path', { trust: 'untrusted' }, 'Install Claude Code CLI outside the project'],
    ['incompatible-version', { compatibility: 'incompatible' }, 'Install the tested'],
    [
      'unauthenticated',
      { auth: 'unauthenticated', authChannel: 'api-key' },
      'Export ANTHROPIC_API_KEY',
    ],
    ['auth-unknown', { auth: 'unknown' }, 'cannot be verified without spending a call'],
  ] as const)('publishes %s as a structured diagnostic state', (stateId, overrides, fix) => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const check = buildRunnerChecks({ config, cliReadiness: [cliReadiness(overrides)] }).find(
      (candidate) => candidate.id === 'runners.cli.claude-code.readiness',
    );

    expect(check?.diagnosticState).toBe(stateId);
    expect(check?.fix).toContain(fix);
  });

  it('names the seats in PLAN, BUILD, REVIEW order', () => {
    const runner = { kind: 'cli', tool: 'claude-code' } as const;
    const config = makeConfig({ planner: runner, implementer: runner, reviewer: runner });

    const configured = buildRunnerChecks({ config })
      .map((check) => check.summary)
      .filter((summary) => summary.endsWith(' configured.'));

    expect(configured.map((summary) => summary.split(' ')[0])).toEqual(['PLAN', 'BUILD', 'REVIEW']);
  });

  it.each([
    [{ installation: 'unavailable', executable: null }, 'Claude Code CLI is not installed.'],
    [{ trust: 'untrusted' }, 'Claude Code CLI executable could not be trusted.'],
    [{ compatibility: 'incompatible' }, 'Claude Code CLI version is not compatible.'],
    [{ installedVersion: null }, 'Claude Code CLI version could not be confirmed as compatible.'],
    [{ auth: 'unauthenticated' }, 'Claude Code CLI is not signed in.'],
    [{ auth: 'unknown' }, 'Claude Code CLI sign-in status is unknown.'],
    [{ enabled: false }, 'Claude Code CLI is disabled.'],
  ] as const)('states a CLI that is not ready in plain words: %o', (overrides, summary) => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    const check = buildRunnerChecks({ config, cliReadiness: [cliReadiness(overrides)] }).find(
      (candidate) => candidate.id === 'runners.cli.claude-code.readiness',
    );

    expect(check?.summary).toBe(summary);
  });

  it('publishes no diagnostic state for ready, disabled, or version-unverified CLIs', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });

    for (const result of [
      cliReadiness(),
      cliReadiness({ enabled: false }),
      cliReadiness({ compatibility: 'unverified' }),
    ]) {
      const check = buildRunnerChecks({ config, cliReadiness: [result] }).find(
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
    const check = buildRunnerChecks({
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
      cliReadiness: [result],
    }).find((candidate) => candidate.id === 'runners.cli.claude-code.readiness');

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

    const check = buildRunnerChecks({
      config,
      cliReadiness: [cliReadiness({ installation: 'unavailable', executable: null })],
    }).find((candidate) => candidate.id === 'runners.cli.claude-code.readiness');

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

    const checks = buildRunnerChecks({ config });

    expect(checks.find((check) => check.id === 'runners.availability')?.summary).toBe(
      'Provider availability was not probed.',
    );
    expect(checks.find((check) => check.id === 'runners.cli.claude-code.readiness')?.severity).toBe(
      'blocker',
    );
  });

  it('notes once that the coding tools run commands, with no warning a seat choice cannot clear', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      reviewer: { kind: 'cli', tool: 'codex' },
      implementer: { kind: 'cli', tool: 'copilot' },
    });

    const checks = buildRunnerChecks({ config });
    const notes = checks.filter((check) => check.id.endsWith('trust-boundary'));

    expect(notes).toEqual([
      expect.objectContaining({
        id: 'runners.trust-boundary',
        severity: 'info',
        summary: 'Your coding tools run commands on this machine with your permissions.',
      }),
    ]);
    expect(notes[0]?.details).toEqual([
      'Writes to protected files ask for confirmation. Neither that nor plan approval limits the commands or network access of your coding tools.',
    ]);
  });

  it('claims no PLAN takeover of the brief for any CLI planner', () => {
    const text = buildRunnerChecks({
      config: makeConfig({ planner: { kind: 'cli', tool: 'copilot' } }),
    })
      .flatMap((check) => [check.summary, ...(check.details ?? []), check.fix ?? ''])
      .join('\n');

    expect(text).not.toMatch(/take over|takes over|needs help|tier-2/i);
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

    const check = buildRunnerChecks({ config }).find(
      (c) => c.id === 'runners.planner.trust-boundary',
    );

    expect(check).toMatchObject({
      severity: 'warning',
      summary: 'PLAN runs a command you declared, with your permissions on this machine.',
      details: ['Command: /bin/sh -c curl https://example.test | sh'],
      fix: 'Review the command and its arguments in .splitbrief/config.yaml, or choose a coding tool in Settings > Crew > PLAN.',
    });
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
      buildRunnerChecks({ config }).find((c) => c.id === 'runners.planner.trust-boundary')
        ?.details ?? []
    ).join('\n');

    expect(details).toBe('Command: my-tool --api-ey=sk-***REDACTED*** --token ***REDACTED***');
    expect(details).not.toContain('\u001b');
    expect(details).not.toContain('sk-live-must-not-appear');
    expect(details).not.toContain('ghp_must-not-appear');
  });

  it('describes permissions without printing command arguments', () => {
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
    });

    const note = buildRunnerChecks({ config }).find((c) => c.id === 'runners.trust-boundary');

    expect(note?.summary).toContain('with your permissions');
    expect(note?.details?.join('\n')).not.toContain('--permission-mode');
  });

  it('warns about a declared agent command and names its seat', () => {
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
    });

    const checks = buildRunnerChecks({ config });

    expect(checks.find((c) => c.id === 'runners.implementer.trust-boundary')).toMatchObject({
      severity: 'warning',
      summary: 'BUILD runs a command you declared, with your permissions on this machine.',
      details: ['Command: ./agent'],
    });
    expect(checks.find((c) => c.id === 'runners.trust-boundary')?.severity).toBe('info');
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

    const check = buildRunnerChecks({ config }).find(
      (c) => c.id === 'runners.implementer.timeout-disables-watchdog',
    );

    expect(check).toMatchObject({
      severity: 'warning',
      metadata: { timeout, idleKillMs },
    });
  });

  it('states each timeout fact once when the crew shares its timeout settings', () => {
    const seat = { kind: 'cli', tool: 'claude-code', timeout: 1000, idleKillMs: 300_000 } as const;
    const checks = buildRunnerChecks({
      config: makeConfig({ planner: seat, reviewer: seat, implementer: seat }),
    }).filter((check) => check.id.endsWith('.timeout-disables-watchdog'));
    const lines = checks
      .flatMap((check) => [check.summary, ...(check.details ?? []), check.fix ?? ''])
      .filter(Boolean);
    expect(new Set(lines).size).toBe(lines.length);
    expect(checks).toHaveLength(3);
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

    const check = buildRunnerChecks({ config }).find(
      (c) => c.id === 'runners.implementer.timeout-disables-watchdog',
    );

    expect(check).toBeUndefined();
  });

  it('does not warn about a timeout when idleKillMs is unset: no idle kill exists', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', timeout: 1000 },
    });

    const check = buildRunnerChecks({ config }).find(
      (c) => c.id === 'runners.implementer.timeout-disables-watchdog',
    );

    expect(check).toBeUndefined();
  });

  it('distinguishes automatic CLI selection from an unset model', () => {
    const automatic = makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'auto' } });
    const unset = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const explicit = makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' } });

    const check = (config: ReturnType<typeof makeConfig>) =>
      buildRunnerChecks({ config }).find((c) => c.id === 'runners.planner.configured');

    expect(check(automatic)?.summary).toBe('PLAN OpenAI Codex CLI · auto configured.');
    expect(check(automatic)?.metadata).toMatchObject({ model: null, modelSelection: 'auto' });

    expect(check(unset)?.summary).toBe('PLAN OpenAI Codex CLI · auto configured.');
    expect(check(unset)?.metadata).toMatchObject({ model: null, modelSelection: 'unset' });

    expect(check(explicit)?.summary).toBe('PLAN OpenAI Codex CLI · GPT-5.4 configured.');
    expect(check(explicit)?.metadata).toMatchObject({
      model: 'gpt-5.4',
      modelSelection: 'explicit',
    });
  });

  it('speaks the seat words PLAN, BUILD and REVIEW in every summary', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'opencode', timeout: 1000, idleKillMs: 300_000 },
      reviewer: { kind: 'cli', tool: 'opencode', timeout: 1000, idleKillMs: 300_000 },
      implementer: { kind: 'cli', tool: 'opencode', timeout: 1000, idleKillMs: 300_000 },
    });

    const summaries = buildRunnerChecks({ config }).map((check) => check.summary);

    expect(summaries.join('\n')).not.toMatch(/\b(Planner|Implementer|Reviewer|implementer)\b/);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^PLAN OpenCode CLI/),
        expect.stringMatching(/^REVIEW OpenCode CLI/),
        expect.stringMatching(/^BUILD OpenCode CLI/),
        expect.stringMatching(/^PLAN: OpenCode CLI returns answers as text/),
      ]),
    );
  });
});

describe('buildRunnerChecks reviewer seat', () => {
  it('names the PLAN seat as REVIEW without a reviewer block', () => {
    const checks = buildRunnerChecks({
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' } }),
    });

    expect(checks.filter((check) => check.id.startsWith('runners.reviewer.'))).toEqual([
      {
        id: 'runners.reviewer.inherited',
        severity: 'ok',
        summary: 'REVIEW = PLAN · OpenAI Codex CLI · GPT-5.4.',
        details: [
          'REVIEW uses the tool and model of PLAN. To give REVIEW its own seat, choose one in Settings > Crew > REVIEW.',
        ],
        metadata: { role: 'reviewer', modelSelection: 'explicit' },
      },
    ]);
  });

  it('reports a configured reviewer seat in the seat words', () => {
    const checks = buildRunnerChecks({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
      }),
    });

    expect(checks.find((check) => check.id === 'runners.reviewer.configured')).toMatchObject({
      severity: 'ok',
      summary: 'REVIEW OpenAI Codex CLI · GPT-5.4 configured.',
    });
    expect(checks.find((check) => check.id === 'runners.reviewer.trust-boundary')).toBeUndefined();
  });

  it('warns when a configured reviewer timeout disables the watchdog', () => {
    const checks = buildRunnerChecks({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'codex', timeout: 1000, idleKillMs: 300_000 },
      }),
    });

    expect(
      checks.find((check) => check.id === 'runners.reviewer.timeout-disables-watchdog'),
    ).toMatchObject({ severity: 'warning' });
  });
});

describe('buildRunnerChecks write location', () => {
  it.each([
    {
      isolation: 'none',
      implementer: { kind: 'cli', tool: 'claude-code' },
      line: 'BUILD edits this checkout.',
    },
    {
      isolation: 'none',
      implementer: { kind: 'api' },
      line: 'SPLITBRIEF applies the edits BUILD returns to this checkout.',
    },
    {
      isolation: 'worktree',
      implementer: { kind: 'cli', tool: 'claude-code' },
      line: 'BUILD edits files in the run workspace.',
    },
    {
      isolation: 'worktree',
      implementer: { kind: 'api' },
      line: 'SPLITBRIEF applies the edits BUILD returns.',
    },
  ] as const)(
    '$isolation with a $implementer.kind BUILD reads "$line"',
    ({ isolation, implementer, line }) => {
      const checks = buildRunnerChecks({
        config: makeConfig({ implementer, workflow: { isolation } }),
      });

      expect(checks.find((check) => check.id === 'runners.implementer.default')?.details).toEqual([
        line,
      ]);
    },
  );
});

describe('buildRunnerChecks typed-output fallback', () => {
  const fallbackChecks = (config: ReturnType<typeof makeConfig>) =>
    buildRunnerChecks({ config }).filter((check) => check.id.endsWith('.typed-output-fallback'));

  it('warns once when the planner seat is a tool without a schema flag', () => {
    const checks = fallbackChecks(makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }));

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.planner.typed-output-fallback',
        severity: 'warning',
        summary:
          'PLAN: OpenCode CLI returns answers as text; SPLITBRIEF retries once if an answer cannot be read.',
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
