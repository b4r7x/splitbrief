import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_CLI_ADMISSION_VERDICT,
  ANTIGRAVITY_CLI_CANDIDATE_PATHS,
  CLI_COMPILER_EVIDENCE,
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  CLI_TOOL_TRUST,
  COMMAND_CODE_CLI_ADMISSION_VERDICT,
  CURSOR_CLI_ADMISSION_VERDICT,
  CUSTOM_ONLY_CLI_TOOL_DEFINITIONS,
  EXCLUDED_CLI_TOOL_IDS,
  IMPLEMENTER_CLI_TOOL_IDS,
  NATIVE_CLI_CATALOG_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
  cliAuthChannelHostStateAccess,
  cliModelPolicyViolations,
  cliToolSupportsRole,
  defaultCliAuthChannel,
  getCliModelPolicy,
  hasNativeCliCatalog,
  selectCliAuthChannel,
  type CliModelPolicy,
} from './cli-tool-catalog.js';
import { classifyCliAdmittedVersion, classifyCliCompilerVersion } from './cli-version.js';
import { CLI_PLANNER_ADAPTERS } from '../../engine/runners/cli-tools/registry.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

const EXISTING_CLI_TOOL_IDS = [
  'claude-code',
  'codex',
  'opencode',
  'copilot',
  'kilo-code',
  'cursor',
  'command-code',
] as const;

function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

describe('CLI tool catalog', () => {
  it('admits Cursor and Command Code as active CLI tools', () => {
    expect(CURSOR_CLI_ADMISSION_VERDICT).toBe('PASS');
    expect(COMMAND_CODE_CLI_ADMISSION_VERDICT).toBe('PASS');
    expect(ANTIGRAVITY_CLI_ADMISSION_VERDICT).toBe('OMIT');
    expect(CLI_TOOL_CATALOG.cursor.admission.state).toBe('active');
    expect(CLI_TOOL_CATALOG['command-code'].admission.state).toBe('active');
    expect(Object.keys(CLI_TOOL_CATALOG)).toEqual(EXISTING_CLI_TOOL_IDS);
    expect(Object.keys(CLI_TOOL_TRUST)).toEqual(EXISTING_CLI_TOOL_IDS);
    expect(CLI_TOOL_IDS).toEqual(EXISTING_CLI_TOOL_IDS);
    expect(PLANNER_CLI_TOOL_IDS).toEqual(
      CLI_TOOL_IDS.filter((id) => CLI_TOOL_CATALOG[id].roles.includes('planner')),
    );
    expect(IMPLEMENTER_CLI_TOOL_IDS).toEqual(
      CLI_TOOL_IDS.filter((id) => CLI_TOOL_CATALOG[id].roles.includes('implementer')),
    );
  });

  it('gives every admitted CLI the same structural posture', () => {
    for (const id of EXISTING_CLI_TOOL_IDS) {
      const descriptor = CLI_TOOL_CATALOG[id];

      expect(descriptor.id).toBe(id);
      expect(descriptor.category).toBe('cli');
      expect(descriptor.executableAliases).toContain(descriptor.command);
      expect(descriptor.roles).toEqual(['planner', 'implementer']);
      expect(descriptor.modelPolicy).toEqual({ planner: 'optional', implementer: 'optional' });
      expect(descriptor.mandatoryPreflightFacts).toEqual([
        'executable',
        'trust',
        'version',
        'compatibility',
        'authentication',
        'model-catalog',
        'model-runnability',
      ]);
      expect(descriptor.admission).toEqual({ state: 'active' });
      expect(cliToolSupportsRole(id, 'planner')).toBe(true);
      expect(cliToolSupportsRole(id, 'implementer')).toBe(true);
      expect(descriptor.shell).toEqual({ planner: true, implementer: true });
      expect(descriptor.network).toEqual({ planner: true, implementer: true });
      expect(descriptor.directWrite).toEqual({ planner: false, implementer: true });
      expect(descriptor.compatibility.installUrl).toMatch(/^https:\/\//);
      expect(descriptor.compatibility.evidence.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (id === 'cursor') {
        expect(descriptor.compatibility.testedVersion).toBe('2026.08.25-3e8eec8');
        expect(descriptor.compatibility.minimumAdmittedVersion).toBe('2026.08.25-3e8eec8');
        expect(descriptor.compatibility.versionScheme).toBe('calver');
      } else {
        expect(descriptor.compatibility.testedVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(descriptor.compatibility.minimumAdmittedVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(descriptor.compatibility.versionScheme).toBe('semver');
      }
    }
  });

  it('pins the minimum admitted version of every CLI', () => {
    expect(
      Object.fromEntries(
        CLI_TOOL_IDS.map((id) => [id, CLI_TOOL_CATALOG[id].compatibility.minimumAdmittedVersion]),
      ),
    ).toEqual({
      'claude-code': '2.0.0',
      codex: '0.40.0',
      opencode: '0.5.0',
      copilot: '0.3.0',
      'kilo-code': '0.1.0',
      cursor: '2026.08.25-3e8eec8',
      'command-code': '1.39.2',
    });
  });

  it('admits native catalog execution only for the six structurally declared CLIs', () => {
    expect(NATIVE_CLI_CATALOG_TOOL_IDS).toEqual([
      'codex',
      'opencode',
      'copilot',
      'kilo-code',
      'cursor',
      'command-code',
    ]);
    expect(hasNativeCliCatalog('copilot')).toBe(true);
  });

  it('leaves no tool declaring a static, unverifiable model catalog', () => {
    const staticCatalogTools = CLI_TOOL_IDS.filter(
      (id) => CLI_TOOL_CATALOG[id].modelDiscoveryMode === 'static-catalog-unverified',
    );

    expect(staticCatalogTools).toEqual([]);
  });

  it('declares project-internal state prefixes only for tools proven to rewrite them', () => {
    expect(
      Object.fromEntries(CLI_TOOL_IDS.map((id) => [id, CLI_TOOL_CATALOG[id].internalStatePaths])),
    ).toEqual({
      'claude-code': [],
      codex: [],
      opencode: [
        '.opencode/package-lock.json',
        '.opencode/package.json',
        '.opencode/node_modules/',
      ],
      copilot: [],
      'kilo-code': [],
      cursor: [],
      'command-code': [],
    });
  });

  it('describes planner tier-2 write authority without changing ordinary planning posture', () => {
    const tier2AutoAllowFlags = {
      'claude-code': [],
      codex: ['--sandbox workspace-write'],
      opencode: [],
      copilot: ['--allow-all', '--no-ask-user'],
      'kilo-code': ['--auto'],
      cursor: ['--force'],
      'command-code': ['--yolo'],
    } as const;

    for (const id of EXISTING_CLI_TOOL_IDS) {
      const trust = CLI_TOOL_TRUST[id];
      const descriptor = CLI_TOOL_CATALOG[id];

      expect(trust.planner).toMatchObject({
        mayWriteFilesDirectly: false,
        autoAllowFlags: [],
      });
      expect(descriptor.directWrite.planner).toBe(false);
      expect(descriptor.automaticApproval.planner).toBe(false);
      expect(trust.plannerTier2FullEscalation).toEqual({
        mayWriteFilesDirectly: true,
        autoAllowFlags: tier2AutoAllowFlags[id],
      });
      expect(descriptor.plannerTier2FullEscalation).toBe(trust.plannerTier2FullEscalation);
    }
  });

  it.each([
    ['0.40.0', 'compatible'],
    ['0.40.7', 'compatible'],
    ['0.41.0', 'compatible'],
    ['0.146.0', 'compatible'],
    ['0.39.9', 'incompatible'],
    ['0.40.0-rc.1', 'unverified'],
    ['0.40', 'unverified'],
  ] as const)(
    'classifies %s through the descriptor-owned compatibility gate',
    (version, expected) => {
      const input = {
        installedVersion: version,
        minimumAdmittedVersion: CLI_TOOL_CATALOG.codex.compatibility.minimumAdmittedVersion,
      };
      expect(classifyCliAdmittedVersion(input)).toBe(expected);
      expect(classifyCliAdmittedVersion({ ...input, versionScheme: 'semver' })).toBe(expected);
    },
  );

  it('keeps compiler evidence exact-version-only and immutable', () => {
    expect(Object.keys(CLI_COMPILER_EVIDENCE)).toEqual(EXISTING_CLI_TOOL_IDS);
    for (const id of EXISTING_CLI_TOOL_IDS) {
      const evidence = CLI_COMPILER_EVIDENCE[id];
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Object.isFrozen(evidence.transports)).toBe(true);
      expect(evidence.fixtureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (evidence.state === 'unsupported') {
        expect(evidence.version).toBe('');
        expect(evidence.transports).toEqual([]);
        expect(evidence.unsupportedReason).toBeTruthy();
        continue;
      }
      expect(evidence.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(evidence.transports.length).toBeGreaterThan(0);
      expect(evidence.terminalContract).toMatch(/v1$/);
    }
  });

  it('never reports compiler readiness beyond the exact tested version', () => {
    const newerPairs = [
      ['opencode', '1.18.16'],
      ['claude-code', '2.1.233'],
      ['codex', '0.147.1'],
      ['kilo-code', '7.0.50'],
    ] as const;

    for (const [id, newerVersion] of newerPairs) {
      const evidence = CLI_COMPILER_EVIDENCE[id];
      expect(evidence.state).not.toBe('unsupported');
      // The implementer-path gate stays forward-compatible...
      expect(
        classifyCliAdmittedVersion({
          installedVersion: newerVersion,
          minimumAdmittedVersion: evidence.version,
        }),
      ).toBe('compatible');
      // ...but the compiler path must not borrow that readiness (REQ-049).
      expect(
        classifyCliCompilerVersion({
          installedVersion: newerVersion,
          exactAdmittedVersion: evidence.version,
        }),
      ).toBe('newer');
    }
  });

  it.each([
    ['claude-code', '2.1.220'],
    ['codex', '0.146.0'],
    ['copilot', '1.0.77'],
    ['kilo-code', '7.0.49'],
    ['opencode', '1.18.10'],
  ] as const)('admits the current %s release above its tested minimum', (id, installedVersion) => {
    expect(
      classifyCliAdmittedVersion({
        installedVersion,
        minimumAdmittedVersion: CLI_TOOL_CATALOG[id].compatibility.minimumAdmittedVersion,
      }),
    ).toBe('compatible');
  });

  it('keeps omitted candidate runtime adapter sources absent', () => {
    for (const relativePath of ANTIGRAVITY_CLI_CANDIDATE_PATHS) {
      expect(existsSync(resolveRepoPath(relativePath))).toBe(false);
    }
    expect('cursor' in CLI_TOOL_CATALOG).toBe(true);
    expect('command-code' in CLI_TOOL_CATALOG).toBe(true);
    expect('antigravity' in CLI_TOOL_CATALOG).toBe(false);
  });

  it('excludes deferred and rejected CLI tool IDs from the assembled catalog', () => {
    for (const id of EXCLUDED_CLI_TOOL_IDS) {
      expect(CLI_TOOL_IDS).not.toContain(id);
      expect(id in CLI_TOOL_CATALOG).toBe(false);
    }
  });

  it('marks Kiro, Antigravity, Gemini, Cline, and Qwen as custom-only', () => {
    expect(CUSTOM_ONLY_CLI_TOOL_DEFINITIONS.map(({ id }) => id)).toEqual([
      'kiro',
      'antigravity',
      'gemini',
      'cline',
      'qwen',
    ]);

    for (const tool of CUSTOM_ONLY_CLI_TOOL_DEFINITIONS) {
      expect(tool.category).toBe('cli');
      expect(tool.admission.state).toBe('custom-only');
      expect(tool.admission.reason).toBeTypeOf('string');
      expect(tool.admission.reason.length).toBeGreaterThan(0);
      expect(CLI_TOOL_CATALOG).not.toHaveProperty(tool.id);
      expect(EXCLUDED_CLI_TOOL_IDS).toContain(tool.id);
    }
  });

  it('isolates catalog descriptors from mutation', () => {
    const descriptor = CLI_TOOL_CATALOG.codex;

    expect(Reflect.set(descriptor, 'displayName', 'Changed')).toBe(false);
    expect(Reflect.set(descriptor.roles, 0, 'implementer')).toBe(false);
    expect(Reflect.set(descriptor.modelPolicy, 'planner', 'required')).toBe(false);
    expect(Reflect.set(descriptor.auth.env, 0, 'CHANGED')).toBe(false);
    expect(Reflect.set(descriptor.auth.channels, 0, descriptor.auth.channels[1])).toBe(false);
    expect(Reflect.set(descriptor.auth.channels[0]?.env ?? [], 0, 'CHANGED')).toBe(false);
    expect(Reflect.set(descriptor.executableAliases, 0, 'changed')).toBe(false);
    expect(Reflect.set(descriptor.mandatoryPreflightFacts, 0, 'changed')).toBe(false);
    expect(Reflect.set(descriptor.compatibility, 'minimumAdmittedVersion', '0.0.0')).toBe(false);
    expect(Reflect.set(descriptor.compatibility.evidence, 'asOf', '1900-01-01')).toBe(false);
    expect(Reflect.set(CLI_TOOL_TRUST.codex.implementer.autoAllowFlags, 0, '--changed')).toBe(
      false,
    );
    expect(
      Reflect.set(CLI_TOOL_TRUST.codex.plannerTier2FullEscalation.autoAllowFlags, 0, '--changed'),
    ).toBe(false);

    expect(CLI_TOOL_CATALOG.codex.displayName).toBe('OpenAI Codex CLI');
    expect(CLI_TOOL_CATALOG.codex.roles).toEqual(['planner', 'implementer']);
    expect(CLI_TOOL_CATALOG.codex.modelPolicy.planner).toBe('optional');
    expect(CLI_TOOL_CATALOG.codex.auth.env).toEqual([]);
    expect(CLI_TOOL_CATALOG.codex.executableAliases).toEqual(['codex']);
    expect(CLI_TOOL_CATALOG.codex.compatibility.minimumAdmittedVersion).toBe('0.40.0');
    expect(CLI_TOOL_CATALOG.codex.compatibility.evidence.asOf).not.toBe('1900-01-01');
    expect(CLI_TOOL_TRUST.codex.implementer.autoAllowFlags).toEqual(['--sandbox workspace-write']);
    expect(CLI_TOOL_TRUST.codex.plannerTier2FullEscalation.autoAllowFlags).toEqual([
      '--sandbox workspace-write',
    ]);
  });

  it('enforces required, optional, backend-default, and auto-only model policies', () => {
    // Each rule is independent: one selection can trip more than one, so the
    // expectations are explicit tuples rather than a derived cross-product.
    const cases: Array<{
      policy: CliModelPolicy;
      selection: { model?: string; customModels?: string[] };
      fields: readonly string[];
    }> = [
      { policy: 'required', selection: {}, fields: ['model'] },
      { policy: 'required', selection: { model: 'auto' }, fields: ['model'] },
      { policy: 'required', selection: { model: 'AUTO' }, fields: ['model'] },
      { policy: 'required', selection: { model: 'fixture-model' }, fields: [] },
      { policy: 'required', selection: { customModels: ['fixture-model'] }, fields: ['model'] },

      { policy: 'optional', selection: {}, fields: [] },
      { policy: 'optional', selection: { model: 'auto' }, fields: [] },
      { policy: 'optional', selection: { model: 'AUTO' }, fields: [] },
      { policy: 'optional', selection: { model: 'fixture-model' }, fields: [] },
      { policy: 'optional', selection: { customModels: ['fixture-model'] }, fields: [] },

      { policy: 'backend-default', selection: {}, fields: [] },
      { policy: 'backend-default', selection: { model: 'auto' }, fields: [] },
      { policy: 'backend-default', selection: { model: 'AUTO' }, fields: [] },
      { policy: 'backend-default', selection: { model: 'fixture-model' }, fields: ['model'] },
      {
        policy: 'backend-default',
        selection: { customModels: ['fixture-model'] },
        fields: ['customModels'],
      },

      { policy: 'auto-only', selection: {}, fields: [] },
      { policy: 'auto-only', selection: { model: 'auto' }, fields: [] },
      { policy: 'auto-only', selection: { model: 'AUTO' }, fields: [] },
      { policy: 'auto-only', selection: { model: 'fixture-model' }, fields: ['model'] },
      {
        policy: 'auto-only',
        selection: { customModels: ['fixture-model'] },
        fields: ['customModels'],
      },
    ];

    for (const { policy, selection, fields } of cases) {
      expect(cliModelPolicyViolations(policy, selection).map(({ field }) => field)).toEqual(fields);
    }
  });

  it('declares only policies that accept both spellings of automatic selection', () => {
    const shipped = new Set(
      CLI_TOOL_IDS.flatMap((id) => [
        getCliModelPolicy(id, 'planner'),
        getCliModelPolicy(id, 'implementer'),
      ]),
    );

    // `required`, `backend-default` and `auto-only` are exercised above as pure
    // policy branches; no shipped tool declares them, so the picker never has
    // to reconcile a tool that refuses the automatic row it always offers.
    expect([...shipped]).toEqual(['optional']);

    for (const policy of shipped) {
      expect(cliModelPolicyViolations(policy, {}), policy).toEqual([]);
      expect(cliModelPolicyViolations(policy, { model: 'auto' }), policy).toEqual([]);
    }
  });

  it('names the automatic sentinel in the messages that reject it', () => {
    expect(cliModelPolicyViolations('required', { model: 'auto' })).toEqual([
      {
        field: 'model',
        message:
          'model "auto" delegates to the tool default, but this CLI model policy requires an explicit model ID',
      },
    ]);
    expect(cliModelPolicyViolations('required', {})).toEqual([
      { field: 'model', message: 'model is required by this CLI model policy' },
    ]);
    expect(cliModelPolicyViolations('auto-only', { model: 'fixture-model' })).toEqual([
      {
        field: 'model',
        message: 'model must be omitted or "auto" for the "auto-only" CLI model policy',
      },
    ]);
  });

  it('selects auth and billing as one explicit channel', () => {
    expect(selectCliAuthChannel('codex', { channel: 'session' })).toEqual({
      id: 'session',
      env: [],
      stateBridge: 'host-cli-state',
      billing: 'subscription-included',
      hostKeychainPlatforms: [],
    });
    expect(selectCliAuthChannel('codex', { channel: 'api-key' })).toEqual({
      id: 'api-key',
      env: ['OPENAI_API_KEY'],
      stateBridge: 'none',
      billing: 'api-metered',
      hostKeychainPlatforms: [],
    });
    expect(selectCliAuthChannel('codex', undefined)).toBeUndefined();
    expect(selectCliAuthChannel('copilot', { channel: 'api-key' })).toBeUndefined();
    expect(CLI_TOOL_CATALOG['claude-code'].auth.env).toEqual([]);
    expect(CLI_TOOL_CATALOG.codex.auth.env).toEqual([]);
    expect(CLI_TOOL_CATALOG.copilot.auth.env).toEqual(['GH_TOKEN', 'GITHUB_TOKEN']);
  });

  it('defaults an unset auth selection to the host session when the tool declares one', () => {
    expect(defaultCliAuthChannel('claude-code').id).toBe('session');
    expect(defaultCliAuthChannel('codex').id).toBe('session');
    expect(defaultCliAuthChannel('copilot').id).toBe('session');
  });

  it('defaults a session-less tool to its declared bridge-free channel', () => {
    expect(defaultCliAuthChannel('opencode').id).toBe('provider-dependent');
    expect(defaultCliAuthChannel('kilo-code').id).toBe('provider-dependent');
  });

  it('declares Claude Code and Cursor Agent CLI session credentials keychain items on macOS and nowhere else', () => {
    for (const tool of CLI_TOOL_IDS) {
      for (const channel of CLI_TOOL_CATALOG[tool].auth.channels) {
        expect({ tool, channel: channel.id, platforms: channel.hostKeychainPlatforms }).toEqual({
          tool,
          channel: channel.id,
          platforms:
            (tool === 'claude-code' || tool === 'cursor') && channel.id === 'session'
              ? ['darwin']
              : [],
        });
      }
    }
  });

  it('routes the Claude Code session channel through the host account only on macOS', () => {
    const session = selectCliAuthChannel('claude-code', { channel: 'session' });
    const apiKey = selectCliAuthChannel('claude-code', { channel: 'api-key' });
    if (session === undefined || apiKey === undefined) throw new Error('missing Claude channel');

    expect(cliAuthChannelHostStateAccess(session, 'darwin')).toBe('host-account');
    expect(cliAuthChannelHostStateAccess(session, 'linux')).toBe('bridged-files');
    expect(cliAuthChannelHostStateAccess(session, 'win32')).toBe('bridged-files');
    expect(cliAuthChannelHostStateAccess(apiKey, 'darwin')).toBe('none');
  });

  it('routes the Cursor Agent CLI session channel through the host account only on macOS', () => {
    const session = selectCliAuthChannel('cursor', { channel: 'session' });
    const apiKey = selectCliAuthChannel('cursor', { channel: 'api-key' });
    if (session === undefined || apiKey === undefined) throw new Error('missing Cursor channel');

    expect(cliAuthChannelHostStateAccess(session, 'darwin')).toBe('host-account');
    expect(cliAuthChannelHostStateAccess(session, 'linux')).toBe('bridged-files');
    expect(cliAuthChannelHostStateAccess(session, 'win32')).toBe('bridged-files');
    expect(cliAuthChannelHostStateAccess(apiKey, 'darwin')).toBe('none');
  });

  it('keeps every other session channel on the file bridge, including on macOS', () => {
    for (const tool of CLI_TOOL_IDS) {
      for (const channel of CLI_TOOL_CATALOG[tool].auth.channels) {
        if ((tool === 'claude-code' || tool === 'cursor') && channel.id === 'session') continue;
        expect({
          tool,
          channel: channel.id,
          access: cliAuthChannelHostStateAccess(channel, 'darwin'),
        }).toEqual({
          tool,
          channel: channel.id,
          access: channel.stateBridge === 'host-cli-state' ? 'bridged-files' : 'none',
        });
      }
    }
  });

  it('admits Command Code with a session-only auth channel and no api-key env', () => {
    const descriptor = CLI_TOOL_CATALOG['command-code'];

    expect(descriptor.auth.kind).toBe('session');
    expect(descriptor.auth.channels).toHaveLength(1);
    expect(descriptor.auth.channels[0]).toMatchObject({ id: 'session', env: [] });
    expect(descriptor.auth.channels[0]?.hostKeychainPlatforms).toEqual([]);
    expect(descriptor.supportsEffort).toBe(true);
    expect(descriptor.effortChannel).toBe('effort-flag');
    expect(descriptor.command).toBe('cmd');
    expect(descriptor.executableAliases).toEqual(['cmd']);
  });

  it('pins Copilot to the release its help-config listing was read from', () => {
    const descriptor = CLI_TOOL_CATALOG.copilot;

    expect(descriptor.modelDiscoveryMode).toBe('native-cli');
    expect(descriptor.compatibility.testedVersion).toBe('1.0.77');
    expect(descriptor.compatibility.evidence.asOf).toBe('2026-09-02');
    // Older Copilot installs stay admitted: a reshaped listing falls back to
    // the catalog lanes, so the tested bump is not a readiness change.
    expect(descriptor.compatibility.minimumAdmittedVersion).toBe('0.3.0');
    expect(
      classifyCliAdmittedVersion({
        installedVersion: '0.3.0',
        minimumAdmittedVersion: descriptor.compatibility.minimumAdmittedVersion,
      }),
    ).toBe('compatible');
  });

  it('pins Command Code to the version its conformance transaction exercised', () => {
    const descriptor = CLI_TOOL_CATALOG['command-code'];

    expect(descriptor.authDiscoveryMode).toBe('status-unverified');
    expect(descriptor.compatibility.testedVersion).toBe('1.39.2');
    expect(descriptor.compatibility.minimumAdmittedVersion).toBe('1.39.2');
    expect(
      classifyCliAdmittedVersion({
        installedVersion: '1.4.0',
        minimumAdmittedVersion: descriptor.compatibility.minimumAdmittedVersion,
      }),
    ).not.toBe('compatible');
  });

  it('names the subscription channel as the Claude Code default', () => {
    // The subscription the user already pays for is the planner default
    // everywhere; no platform resolves a fresh Claude Code runner to metered
    // billing. `.specify/memory/constitution.md` Principle I.
    expect(defaultCliAuthChannel('claude-code')).toMatchObject({
      id: 'session',
      billing: 'subscription-included',
    });
  });
});

describe('effort support', () => {
  it('names the real effort channel of every tool', () => {
    const channels = Object.fromEntries(
      CLI_TOOL_IDS.map((tool) => [tool, CLI_TOOL_CATALOG[tool].effortChannel]),
    );
    expect(channels).toEqual({
      'claude-code': 'effort-flag',
      codex: 'effort-flag',
      opencode: 'variant',
      copilot: 'effort-flag',
      'kilo-code': 'variant',
      cursor: 'model-id',
      'command-code': 'effort-flag',
    });
  });

  it('keeps supportsEffort as the effort-flag channel alone', () => {
    for (const tool of CLI_TOOL_IDS) {
      const descriptor = CLI_TOOL_CATALOG[tool];
      expect({ tool, supportsEffort: descriptor.supportsEffort }).toEqual({
        tool,
        supportsEffort: descriptor.effortChannel === 'effort-flag',
      });
    }
  });

  it('states the same effort fact the planner adapter actually invokes with', () => {
    for (const tool of PLANNER_CLI_TOOL_IDS) {
      const adapter = Object.hasOwn(CLI_PLANNER_ADAPTERS, tool)
        ? CLI_PLANNER_ADAPTERS[tool]
        : undefined;
      if (adapter === undefined) continue;
      expect({ tool, supportsEffort: adapter.supportsEffort }).toEqual({
        tool,
        supportsEffort: CLI_TOOL_CATALOG[tool].supportsEffort,
      });
    }
  });
});
