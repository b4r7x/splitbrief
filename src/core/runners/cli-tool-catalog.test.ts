import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_CLI_ADMISSION_VERDICT,
  ANTIGRAVITY_CLI_CANDIDATE_PATHS,
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  CLI_TOOL_TRUST,
  CURSOR_CLI_CANDIDATE,
  CURSOR_CLI_ADMISSION_VERDICT,
  CURSOR_CLI_RUNTIME_ADAPTER_PATHS,
  CUSTOM_ONLY_CLI_TOOL_DEFINITIONS,
  EXCLUDED_CLI_TOOL_IDS,
  IMPLEMENTER_CLI_TOOL_IDS,
  NATIVE_CLI_CATALOG_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
  classifyCliAdmittedVersion,
  cliModelPolicyViolations,
  cliToolSupportsRole,
  defaultCliAuthChannel,
  getCliModelPolicy,
  selectCliAuthChannel,
  type CliModelPolicy,
} from './cli-tool-catalog.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

const EXISTING_CLI_TOOL_IDS = [
  'claude-code',
  'codex',
  'opencode',
  'aider',
  'copilot',
  'kilo-code',
] as const;

function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

describe('CLI tool catalog', () => {
  it('keeps Cursor as a non-executable candidate outside active registries', () => {
    expect(CURSOR_CLI_ADMISSION_VERDICT).toBe('OMIT');
    expect(ANTIGRAVITY_CLI_ADMISSION_VERDICT).toBe('OMIT');
    expect(CURSOR_CLI_CANDIDATE).toEqual({
      id: 'cursor',
      displayName: 'Cursor Agent CLI',
      command: 'agent',
      category: 'cli',
      executableAliases: ['agent', 'cursor-agent'],
      admission: {
        state: 'not-admitted',
        prerequisite: 'R7-008',
        remediation:
          'Cursor Agent CLI is unavailable until R7-008 verifies an exact build-pinned protocol and a fresh filtered workspace.',
      },
    });
    expect(Object.keys(CLI_TOOL_CATALOG)).toEqual(EXISTING_CLI_TOOL_IDS);
    expect(Object.keys(CLI_TOOL_TRUST)).toEqual(EXISTING_CLI_TOOL_IDS);
    expect(CLI_TOOL_IDS).toEqual(EXISTING_CLI_TOOL_IDS);
    expect(PLANNER_CLI_TOOL_IDS).toEqual(
      CLI_TOOL_IDS.filter((id) => CLI_TOOL_CATALOG[id].roles.includes('planner')),
    );
    expect(IMPLEMENTER_CLI_TOOL_IDS).toEqual(
      CLI_TOOL_IDS.filter((id) => CLI_TOOL_CATALOG[id].roles.includes('implementer')),
    );

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
      expect(descriptor.compatibility.testedVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(descriptor.compatibility.minimumAdmittedVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(descriptor.compatibility.evidence.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    expect(
      Object.fromEntries(
        CLI_TOOL_IDS.map((id) => [id, CLI_TOOL_CATALOG[id].compatibility.minimumAdmittedVersion]),
      ),
    ).toEqual({
      'claude-code': '2.0.0',
      codex: '0.40.0',
      opencode: '0.5.0',
      aider: '0.86.0',
      copilot: '0.3.0',
      'kilo-code': '0.1.0',
    });
  });

  it('admits native catalog execution only for the four structurally declared CLIs', () => {
    expect(NATIVE_CLI_CATALOG_TOOL_IDS).toEqual(['codex', 'opencode', 'aider', 'kilo-code']);
  });

  it.each([
    ['0.40.0', 'compatible'],
    ['0.40.7', 'compatible'],
    ['0.41.0', 'compatible'],
    ['0.146.0', 'compatible'],
    ['0.39.9', 'incompatible'],
    ['0.40.0-rc.1', 'unverified'],
    ['0.40', 'unverified'],
  ] as const)('classifies %s through the descriptor-owned compatibility gate', (version, expected) => {
    expect(
      classifyCliAdmittedVersion({
        installedVersion: version,
        minimumAdmittedVersion: CLI_TOOL_CATALOG.codex.compatibility.minimumAdmittedVersion,
      }),
    ).toBe(expected);
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
    for (const relativePath of [
      ...CURSOR_CLI_RUNTIME_ADAPTER_PATHS,
      ...ANTIGRAVITY_CLI_CANDIDATE_PATHS,
    ]) {
      expect(existsSync(resolveRepoPath(relativePath))).toBe(false);
    }
    expect('cursor' in CLI_TOOL_CATALOG).toBe(false);
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

    expect(CLI_TOOL_CATALOG.codex.displayName).toBe('OpenAI Codex CLI');
    expect(CLI_TOOL_CATALOG.codex.roles).toEqual(['planner', 'implementer']);
    expect(CLI_TOOL_CATALOG.codex.modelPolicy.planner).toBe('optional');
    expect(CLI_TOOL_CATALOG.codex.auth.env).toEqual([]);
    expect(CLI_TOOL_CATALOG.codex.executableAliases).toEqual(['codex']);
    expect(CLI_TOOL_CATALOG.codex.compatibility.minimumAdmittedVersion).toBe('0.40.0');
    expect(CLI_TOOL_CATALOG.codex.compatibility.evidence.asOf).not.toBe('1900-01-01');
    expect(CLI_TOOL_TRUST.codex.implementer.autoAllowFlags).toEqual(['--sandbox workspace-write']);
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
    });
    expect(selectCliAuthChannel('codex', { channel: 'api-key' })).toEqual({
      id: 'api-key',
      env: ['OPENAI_API_KEY'],
      stateBridge: 'none',
      billing: 'api-metered',
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
    expect(defaultCliAuthChannel('aider')).toMatchObject({
      id: 'provider-dependent',
      stateBridge: 'none',
    });
    expect(defaultCliAuthChannel('opencode').id).toBe('provider-dependent');
    expect(defaultCliAuthChannel('kilo-code').id).toBe('provider-dependent');
  });
});
