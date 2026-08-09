import { describe, expect, it } from 'vitest';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import type { RunnerEvidence } from '../../core/discovery/runner-evidence.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import { admitFreshCliStart, runnerGateFor } from './start-gate.js';
import type { RunnerGate, RunnerGateExpectation } from './prepared-execution.js';
import type { AdmittedCustomRunnerInvocation } from './trust.js';

const EXECUTABLE_CONTENT_DIGEST = 'a'.repeat(64);

const freshExecutable = CliExecutableReceiptSchema.parse({
  path: '/usr/local/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  executableIdentity: {
    canonicalPath: '/usr/local/bin/codex',
    realPath: '/usr/local/bin/codex',
    platformFileId: '1:2',
    fingerprint: `1:2:3:4:sha256:${EXECUTABLE_CONTENT_DIGEST}`,
    resolvedAt: 1,
  },
});

const customInvocation: AdmittedCustomRunnerInvocation = {
  kind: 'custom-runner-invocation',
  runner: {
    source: 'configured',
    command: {
      id: 'review',
      label: 'Review changes',
      contract: 'output',
      executable: '/usr/local/bin/reviewer',
      argv: ['--format', 'text'],
      outputFormat: 'text',
      idleWarnMs: 300_000,
      idleKillMs: 1_800_000,
      env: [],
    },
  },
  posture: {
    role: 'implementer',
    source: 'configured',
    cwd: 'disposable-stage',
    stage: 'filtered-disposable-stage',
    environmentAccess: 'declared-references-only',
    filesystem: 'host-user-access',
    network: 'host-network-access',
    result: 'parsed-output-only',
  },
  executable: freshExecutable,
  authorization: 'explicit-grant',
  scope: {
    projectIdentity: `sha256:${'b'.repeat(64)}`,
    definitionId: 'review',
    definitionDigest: `sha256:${'c'.repeat(64)}`,
  },
};

type EvidenceOverrides = Readonly<{
  tool?: CliToolId;
  source?: RunnerEvidence['context']['source'];
  runnerId?: string;
  contextKey?: string;
  selectionId?: string;
  installation?: RunnerEvidence['installation'];
  executable?: RunnerEvidence['executable'];
  compatibility?: RunnerEvidence['compatibility'];
  auth?: RunnerEvidence['auth'];
}>;

function freshEvidence(overrides: EvidenceOverrides = {}): RunnerEvidence {
  const tool = overrides.tool ?? 'codex';
  const contextKey = overrides.contextKey ?? 'fresh-context';
  const testedVersion = CLI_TOOL_CATALOG[tool].compatibility.testedVersion;
  return {
    runner: {
      id: overrides.runnerId ?? tool,
      kind: 'cli',
      locality: 'local',
      enabled: 'enabled',
    },
    context: { key: contextKey, observedAt: 1, source: overrides.source ?? 'fresh' },
    installation: overrides.installation ?? 'installed',
    executable: overrides.executable ?? {
      kind: 'trusted',
      identity: {
        canonicalPath: `/usr/local/bin/${tool}`,
        realPath: `/usr/local/bin/${tool}`,
        platformFileId: '1:2',
        fingerprint: `1:2:3:4:sha256:${EXECUTABLE_CONTENT_DIGEST}`,
        resolvedAt: 1,
      },
    },
    compatibility: overrides.compatibility ?? {
      kind: 'compatible',
      installedVersion: testedVersion,
      testedVersion,
    },
    credential: 'present',
    auth: overrides.auth ?? 'verified',
    endpoint: { kind: 'not-run' },
    catalog: { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: overrides.selectionId ?? 'unselected',
      observedAt: 1,
      contextKey,
    },
  };
}

function admit(
  evidence: RunnerEvidence,
  overrides: Partial<
    Pick<Parameters<typeof admitFreshCliStart>[0], 'interaction' | 'unverifiedAuth'>
  > = {},
) {
  return admitFreshCliStart({
    tool: 'codex',
    evidence,
    expectedContextKey: 'fresh-context',
    expectedSelectionId: 'unselected',
    interaction: overrides.interaction ?? 'interactive',
    unverifiedAuth: overrides.unverifiedAuth ?? 'denied',
  });
}

describe('fresh CLI start gate', () => {
  it('rejects cached evidence even when every cached fact looks ready', () => {
    expect(admit(freshEvidence({ source: 'cached' }))).toEqual({
      kind: 'denied',
      reason: { kind: 'evidence-source', source: 'cached' },
    });
  });

  it('rejects evidence for a different configured runner identity', () => {
    expect(admit(freshEvidence({ runnerId: 'claude-code' }))).toEqual({
      kind: 'denied',
      reason: { kind: 'context-mismatch' },
    });
  });

  it('blocks a missing runner installation', () => {
    expect(admit(freshEvidence({ installation: 'missing' }))).toEqual({
      kind: 'denied',
      reason: { kind: 'installation', fact: 'missing' },
    });
  });

  it.each([
    ['missing executable', { kind: 'missing' }, { kind: 'executable', fact: 'missing' }],
    ['untrusted executable', { kind: 'untrusted' }, { kind: 'executable', fact: 'untrusted' }],
    [
      'identity drift',
      { kind: 'identity-drifted' },
      { kind: 'executable', fact: 'identity-drifted' },
    ],
  ] as const)('blocks %s before it can become an execution gate', (_label, executable, reason) => {
    expect(admit(freshEvidence({ executable }))).toEqual({ kind: 'denied', reason });
  });

  it.each([
    ['missing authentication', 'missing'],
    ['invalid authentication', 'invalid'],
    ['policy-denied authentication', 'policy-denied'],
  ] as const)('blocks %s', (_label, auth) => {
    expect(admit(freshEvidence({ auth }))).toEqual({
      kind: 'denied',
      reason: { kind: 'authentication', fact: auth },
    });
  });

  it('blocks an incompatible version', () => {
    const testedVersion = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;
    expect(
      admit(
        freshEvidence({
          compatibility: {
            kind: 'incompatible',
            installedVersion: '0.0.0',
            testedVersion,
          },
        }),
      ),
    ).toEqual({ kind: 'denied', reason: { kind: 'compatibility', fact: 'incompatible' } });
  });

  it('requires an explicit interactive disclosure for compatibility auth unknown', () => {
    const evidence = freshEvidence({ tool: 'aider', auth: 'unknown' });
    const initial = admitFreshCliStart({
      tool: 'aider',
      evidence,
      expectedContextKey: 'fresh-context',
      expectedSelectionId: 'unselected',
      interaction: 'interactive',
      unverifiedAuth: 'denied',
    });
    const disclosed = admitFreshCliStart({
      tool: 'aider',
      evidence,
      expectedContextKey: 'fresh-context',
      expectedSelectionId: 'unselected',
      interaction: 'interactive',
      unverifiedAuth: 'disclosed',
    });

    expect(initial).toEqual({ kind: 'disclosure-required', auth: 'unknown' });
    expect(disclosed).toMatchObject({ kind: 'admitted', gate: { tool: 'aider' } });
  });

  it('surfaces first-class unknown auth for review and admits it only once disclosed', () => {
    // The honest gauge caps a local status read at `unknown` — codex's
    // `login status` reads auth.json and cannot prove a working session — so
    // unknown must be startable interactively, but never silently: without an
    // accepted disclosure it comes back for review, and headless stays
    // fail-closed below.
    expect(admit(freshEvidence({ auth: 'unknown' }))).toEqual({
      kind: 'disclosure-required',
      auth: 'unknown',
    });
    expect(
      admit(freshEvidence({ auth: 'unknown' }), { unverifiedAuth: 'disclosed' }),
    ).toMatchObject({
      kind: 'admitted',
      gate: { tool: 'codex' },
    });
    expect(admit(freshEvidence({ auth: 'unknown' }), { interaction: 'headless' })).toEqual({
      kind: 'denied',
      reason: { kind: 'authentication-unverified' },
    });
  });

  it('requires an explicit headless allowance for unknown auth', () => {
    const evidence = freshEvidence({ tool: 'aider', auth: 'unknown' });
    const denied = admitFreshCliStart({
      tool: 'aider',
      evidence,
      expectedContextKey: 'fresh-context',
      expectedSelectionId: 'unselected',
      interaction: 'headless',
      unverifiedAuth: 'denied',
    });
    const allowed = admitFreshCliStart({
      tool: 'aider',
      evidence,
      expectedContextKey: 'fresh-context',
      expectedSelectionId: 'unselected',
      interaction: 'headless',
      unverifiedAuth: 'allowed',
    });

    expect(denied).toEqual({ kind: 'denied', reason: { kind: 'authentication-unverified' } });
    expect(allowed).toMatchObject({ kind: 'admitted', gate: { tool: 'aider' } });
  });

  it('does not turn a legacy stat-only receipt into fresh start authorization', () => {
    const evidence = freshEvidence({
      executable: {
        kind: 'trusted',
        identity: {
          canonicalPath: '/usr/local/bin/codex',
          realPath: '/usr/local/bin/codex',
          platformFileId: '1:2',
          fingerprint: '1:2:3:4',
          resolvedAt: 1,
        },
      },
    });

    expect(admit(evidence)).toEqual({
      kind: 'denied',
      reason: { kind: 'executable', fact: 'unknown' },
    });
  });
});

describe('prepared runner gates', () => {
  it('binds every current runner kind to slot context and preparation', () => {
    const preparationId = 'preparation-1';
    const gates: readonly RunnerGate[] = [
      {
        kind: 'cli',
        slot: { role: 'planner' },
        preparationId,
        tool: 'codex',
        executable: freshExecutable,
      },
      {
        kind: 'api',
        slot: { role: 'implementer', profile: 'api' },
        preparationId,
        provider: 'openrouter',
        endpointOrigin: 'https://openrouter.ai',
      },
      {
        kind: 'agent-sdk',
        slot: { role: 'implementer', profile: 'sdk' },
        preparationId,
        provider: 'anthropic',
      },
      {
        kind: 'shell',
        slot: { role: 'implementer', profile: 'shell' },
        preparationId,
        command: { kind: 'validated-config' },
      },
      {
        kind: 'agent',
        slot: { role: 'intermediate' },
        preparationId,
        command: { kind: 'configured-custom', invocation: customInvocation },
      },
    ];
    const expectations: readonly RunnerGateExpectation[] = [
      { kind: 'cli', slot: { role: 'planner' }, preparationId, tool: 'codex' },
      {
        kind: 'api',
        slot: { role: 'implementer', profile: 'api' },
        preparationId,
        provider: 'openrouter',
        endpointOrigin: 'https://openrouter.ai',
      },
      {
        kind: 'agent-sdk',
        slot: { role: 'implementer', profile: 'sdk' },
        preparationId,
        provider: 'anthropic',
      },
      {
        kind: 'shell',
        slot: { role: 'implementer', profile: 'shell' },
        preparationId,
        command: { kind: 'validated-config' },
      },
      {
        kind: 'agent',
        slot: { role: 'intermediate' },
        preparationId,
        command: { kind: 'configured-custom', definitionId: 'review' },
      },
    ];

    expect(expectations.map((expected) => runnerGateFor(gates, expected))).toEqual(gates);
    expect(() =>
      runnerGateFor(gates, {
        kind: 'cli',
        slot: { role: 'planner' },
        preparationId: 'preparation-2',
        tool: 'codex',
      }),
    ).toThrow('does not match the prepared planner context');
  });

  it('rejects a same-kind gate from another profile before adapter construction', () => {
    const gates: readonly RunnerGate[] = [
      {
        kind: 'api',
        slot: { role: 'implementer', profile: 'fast' },
        preparationId: 'preparation-1',
        provider: 'openrouter',
        endpointOrigin: 'https://openrouter.ai',
      },
    ];
    let adapterConstructed = false;

    expect(() => {
      runnerGateFor(gates, {
        kind: 'api',
        slot: { role: 'implementer', profile: 'cheap' },
        preparationId: 'preparation-1',
        provider: 'openrouter',
        endpointOrigin: 'https://openrouter.ai',
      });
      adapterConstructed = true;
    }).toThrow('does not match the prepared implementer context');
    expect(adapterConstructed).toBe(false);
  });

  it('rejects a configured custom definition mismatch before adapter construction', () => {
    const gates: readonly RunnerGate[] = [
      {
        kind: 'shell',
        slot: { role: 'implementer', profile: 'reviewer' },
        preparationId: 'preparation-1',
        command: { kind: 'configured-custom', invocation: customInvocation },
      },
    ];
    let adapterConstructed = false;

    expect(() => {
      runnerGateFor(gates, {
        kind: 'shell',
        slot: { role: 'implementer', profile: 'reviewer' },
        preparationId: 'preparation-1',
        command: { kind: 'configured-custom', definitionId: 'publish' },
      });
      adapterConstructed = true;
    }).toThrow('does not match the prepared implementer context');
    expect(adapterConstructed).toBe(false);
  });
});
