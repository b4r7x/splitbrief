import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_CLI_ADMISSION_VERDICT,
  ANTIGRAVITY_CLI_CANDIDATE_PATHS,
  CURSOR_CLI_ADMISSION_VERDICT,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../../core/runners/cli-tool-catalog.js';
import { resolveRepoPath as productionResolveRepoPath } from '../../../core/runners/candidate-admission.js';
import {
  CLI_IMPLEMENTER_ADAPTERS,
  CLI_PLANNER_ADAPTERS,
  lookupCliImplementerAdapter,
  lookupCliPlannerAdapter,
  lookupCliReadinessProbe,
} from './registry.js';
import { CODEX_NATIVE_MODEL_CATALOG_PROBE, codexPlannerAdapter } from './codex.js';
import { isDeclaredCliProbeContract } from './contract.js';

const REPO_ROOT = join(import.meta.dirname, '../../../..');

function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

describe('CLI role registries', () => {
  it('resolves production repo root to the workspace package.json', () => {
    expect(existsSync(productionResolveRepoPath('package.json'))).toBe(true);
    expect(productionResolveRepoPath('package.json')).toBe(resolveRepoPath('package.json'));
  });

  it('matches planner keys to the core planner tuple', () => {
    expect(Object.keys(CLI_PLANNER_ADAPTERS)).toEqual([...PLANNER_CLI_TOOL_IDS]);
    for (const id of PLANNER_CLI_TOOL_IDS) {
      const adapter = CLI_PLANNER_ADAPTERS[id];
      expect(adapter.role).toBe('planner');
      expect(adapter.descriptor.id).toBe(id);
    }
  });

  it('matches implementer keys to the core implementer tuple', () => {
    expect(Object.keys(CLI_IMPLEMENTER_ADAPTERS)).toEqual([...IMPLEMENTER_CLI_TOOL_IDS]);
    for (const id of IMPLEMENTER_CLI_TOOL_IDS) {
      const adapter = CLI_IMPLEMENTER_ADAPTERS[id];
      expect(adapter.role).toBe('implementer');
      expect(adapter.descriptor.id).toBe(id);
    }
  });

  it('keeps Cursor outside both active role registries until R7-008', () => {
    expect(CURSOR_CLI_ADMISSION_VERDICT).toBe('OMIT');
    expect(ANTIGRAVITY_CLI_ADMISSION_VERDICT).toBe('OMIT');

    for (const relativePath of ANTIGRAVITY_CLI_CANDIDATE_PATHS) {
      expect(existsSync(resolveRepoPath(relativePath))).toBe(false);
    }

    expect('cursor' in CLI_PLANNER_ADAPTERS).toBe(false);
    expect('antigravity' in CLI_PLANNER_ADAPTERS).toBe(false);
    expect('cursor' in CLI_IMPLEMENTER_ADAPTERS).toBe(false);
    expect('antigravity' in CLI_IMPLEMENTER_ADAPTERS).toBe(false);
  });
});

describe('CLI registry lookup', () => {
  it('returns admitted planner adapters', () => {
    expect(lookupCliPlannerAdapter('codex')).toBe(CLI_PLANNER_ADAPTERS.codex);
  });

  it('returns admitted implementer adapters', () => {
    expect(lookupCliImplementerAdapter('aider')).toBe(CLI_IMPLEMENTER_ADAPTERS.aider);
  });

  it.each([
    'cursor',
    'antigravity',
    'kiro',
    'unknown-cli',
  ])('rejects unsupported planner lookup for %s before spawn', (toolId) => {
    expect(() => lookupCliPlannerAdapter(toolId)).toThrow(/has no planner configuration/);
  });

  it.each([
    'cursor',
    'antigravity',
    'kiro',
    'unknown-cli',
  ])('rejects unsupported implementer lookup for %s before spawn', (toolId) => {
    expect(() => lookupCliImplementerAdapter(toolId)).toThrow(/has no implementer configuration/);
  });
});

describe('admitted readiness probe contracts', () => {
  it('deep-freezes every role-bound declaration reachable from the registry', () => {
    const adapters = [
      ...Object.values(CLI_PLANNER_ADAPTERS),
      ...Object.values(CLI_IMPLEMENTER_ADAPTERS),
    ];

    for (const adapter of adapters) {
      const { probe } = adapter;
      expect(Object.isFrozen(adapter)).toBe(true);
      expect(Object.isFrozen(probe)).toBe(true);
      expect(Object.isFrozen(probe.version)).toBe(true);
      expect(Object.isFrozen(probe.version.command)).toBe(true);
      expect(Object.isFrozen(probe.auth)).toBe(true);
      expect(Object.isFrozen(probe.auth.command)).toBe(true);
      expect(isDeclaredCliProbeContract(probe)).toBe(true);
      if (!isDeclaredCliProbeContract(probe)) continue;

      const { declared } = probe;
      expect(Object.isFrozen(declared)).toBe(true);
      expect(Object.isFrozen(declared.version)).toBe(true);
      expect(Object.isFrozen(declared.version.command)).toBe(true);
      expect(Object.isFrozen(declared.version.parse)).toBe(true);
      expect(Object.isFrozen(declared.auth)).toBe(true);
      if (declared.auth.kind !== 'not-run') {
        expect(Object.isFrozen(declared.auth.command)).toBe(true);
        expect(Object.isFrozen(declared.auth.parse)).toBe(true);
      }
      expect(Object.isFrozen(declared.catalog)).toBe(true);
      if (declared.catalog.kind !== 'not-run') {
        expect(Object.isFrozen(declared.catalog.command)).toBe(true);
        expect(Object.isFrozen(declared.catalog.parse)).toBe(true);
        if (declared.catalog.manualCommand !== undefined) {
          expect(Object.isFrozen(declared.catalog.manualCommand)).toBe(true);
        }
      }
    }
  });

  it('owns and freezes every reachable declared catalog operation', () => {
    const probe = lookupCliReadinessProbe({ tool: 'codex', role: 'planner' });
    expect(isDeclaredCliProbeContract(probe)).toBe(true);
    if (!isDeclaredCliProbeContract(probe)) return;

    const { declared } = probe;
    if (declared.catalog.kind === 'not-run') return;
    const catalog = declared.catalog;
    const originalParser = catalog.parse;
    const originalCommand = [...catalog.command];

    // The registry owns a copied operation; neither adapter input nor an
    // imported descriptor array can become a mutable execution control plane.
    expect(probe.version.command).not.toBe(codexPlannerAdapter.probe.version.command);
    expect(catalog.command).not.toBe(CODEX_NATIVE_MODEL_CATALOG_PROBE.command);
    expect(Object.isFrozen(probe)).toBe(true);
    expect(Object.isFrozen(declared)).toBe(true);
    expect(Object.isFrozen(declared.version)).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.command)).toBe(true);

    expect(Reflect.set(catalog.command, 0, 'attacker')).toBe(false);
    expect(Reflect.set(catalog, 'manualCommand', ['attacker', 'refresh'])).toBe(false);
    expect(Reflect.set(catalog, 'parse', () => ({ kind: 'success', value: [] }))).toBe(false);
    expect(Reflect.set(catalog, 'timeoutMs', 1)).toBe(false);
    expect(Reflect.set(declared, 'catalog', { kind: 'not-run' })).toBe(false);

    expect(catalog.command).toEqual(originalCommand);
    expect(catalog.parse).toBe(originalParser);
    expect(catalog.timeoutMs).toBe(CODEX_NATIVE_MODEL_CATALOG_PROBE.timeoutMs);

    const manualProbe = lookupCliReadinessProbe({ tool: 'opencode', role: 'planner' });
    expect(isDeclaredCliProbeContract(manualProbe)).toBe(true);
    if (!isDeclaredCliProbeContract(manualProbe)) return;
    const manualCatalog = manualProbe.declared.catalog;
    if (manualCatalog.kind === 'not-run' || manualCatalog.manualCommand === undefined) return;

    expect(Reflect.set(manualCatalog.manualCommand, 0, 'attacker')).toBe(false);
    expect(manualCatalog.manualCommand).toEqual(['opencode', 'models', '--refresh']);
  });

  it('binds the selected role to an admitted declared Codex status probe', () => {
    const planner = lookupCliReadinessProbe({ tool: 'codex', role: 'planner' });
    const implementer = lookupCliReadinessProbe({ tool: 'codex', role: 'implementer' });

    expect(planner).toBe(CLI_PLANNER_ADAPTERS.codex.probe);
    expect(implementer).toBe(CLI_IMPLEMENTER_ADAPTERS.codex.probe);
    expect(isDeclaredCliProbeContract(planner)).toBe(true);
    if (!isDeclaredCliProbeContract(planner)) throw new Error('expected declared Codex probe');

    expect(planner.declared.version.command).toEqual(['codex', '--version']);
    expect(planner.declared.auth).toMatchObject({
      kind: 'auth-status',
      command: ['codex', 'login', 'status'],
      cwd: 'neutral',
    });
    if (planner.declared.auth.kind === 'not-run')
      throw new Error('expected Codex auth status probe');
    // `codex login status` reads auth.json and never talks to the server: a
    // host with an already-burned refresh token still prints "Logged in using
    // ChatGPT" while every real call 401s (measured 2026-08-06). A positive
    // local status is therefore presence, never proof — capped at `unknown`.
    expect(
      planner.declared.auth.parse({
        stdout: 'Logged in using ChatGPT',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toBe('unknown');
    expect(
      planner.declared.auth.parse({
        stdout: 'Not logged in',
        stderr: '',
        exitCode: 1,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toBe('missing');
  });

  it.each([
    ['codex', 'codex-cli 0.40.0', { kind: 'success', value: '0.40.0' }],
    ['claude-code', '2.1.220 (Claude Code)', { kind: 'success', value: '2.1.220' }],
    ['copilot', 'GitHub Copilot CLI 1.0.77.', { kind: 'success', value: '1.0.77' }],
    ['aider', 'aider 0.86.0', { kind: 'success', value: '0.86.0' }],
    ['opencode', '0.5.0', { kind: 'success', value: '0.5.0' }],
    ['kilo-code', '0.1.0', { kind: 'success', value: '0.1.0' }],
    ['codex', 'node 0.40.0', { kind: 'malformed' }],
    ['aider', 'node 0.86.0', { kind: 'malformed' }],
    ['opencode', 'node 0.5.0', { kind: 'malformed' }],
    ['kilo-code', 'node 0.1.0', { kind: 'malformed' }],
    ['codex', 'node 99.0.0\ncodex-cli 0.40.0', { kind: 'malformed' }],
    ['aider', 'node 99.0.0\naider 0.86.0', { kind: 'malformed' }],
    ['opencode', 'node 99.0.0\n0.5.0', { kind: 'malformed' }],
    ['kilo-code', 'node 99.0.0\n0.1.0', { kind: 'malformed' }],
    ['codex', 'codex-cli 0.40.0\ncodex-cli 99.0.0', { kind: 'malformed' }],
    ['aider', 'aider 0.86.0\naider 99.0.0', { kind: 'malformed' }],
    ['opencode', '0.5.0\n99.0.0', { kind: 'malformed' }],
    ['kilo-code', '0.1.0\n99.0.0', { kind: 'malformed' }],
  ] as const)('parses only one canonical %s version descriptor', (tool, stdout, expected) => {
    const probe = lookupCliReadinessProbe({ tool, role: 'planner' });
    expect(isDeclaredCliProbeContract(probe)).toBe(true);
    if (!isDeclaredCliProbeContract(probe)) return;

    expect(
      probe.declared.version.parse({
        stdout,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toEqual(expected);
  });

  it('declares structural, parser-bound native catalog probes without generic argv mutation', () => {
    const aider = lookupCliReadinessProbe({ tool: 'aider', role: 'implementer' });
    const opencode = lookupCliReadinessProbe({ tool: 'opencode', role: 'planner' });
    const kilo = lookupCliReadinessProbe({ tool: 'kilo-code', role: 'planner' });
    const codex = lookupCliReadinessProbe({ tool: 'codex', role: 'planner' });

    expect(isDeclaredCliProbeContract(aider)).toBe(true);
    expect(isDeclaredCliProbeContract(opencode)).toBe(true);
    expect(isDeclaredCliProbeContract(kilo)).toBe(true);
    expect(isDeclaredCliProbeContract(codex)).toBe(true);
    if (
      !isDeclaredCliProbeContract(aider) ||
      !isDeclaredCliProbeContract(opencode) ||
      !isDeclaredCliProbeContract(kilo) ||
      !isDeclaredCliProbeContract(codex)
    ) {
      throw new Error('expected admitted declared probes');
    }

    expect(aider.declared.auth).toEqual({ kind: 'not-run' });
    expect(aider.declared.catalog).toMatchObject({
      kind: 'catalog',
      command: ['aider', '--list-models', ''],
    });
    expect(codex.declared.catalog).toMatchObject({
      kind: 'catalog',
      command: ['codex', 'debug', 'models', '--bundled'],
    });
    expect(opencode.declared.catalog).toMatchObject({
      kind: 'catalog',
      command: ['opencode', 'models'],
      manualCommand: ['opencode', 'models', '--refresh'],
    });
    expect(kilo.declared.catalog).toMatchObject({
      kind: 'catalog',
      command: ['kilo', 'models'],
      manualCommand: ['kilo', 'models', '--refresh'],
    });
    if (
      aider.declared.catalog.kind === 'not-run' ||
      codex.declared.catalog.kind === 'not-run' ||
      opencode.declared.catalog.kind === 'not-run' ||
      kilo.declared.catalog.kind === 'not-run'
    ) {
      throw new Error('expected native catalog probes');
    }
    expect(
      codex.declared.catalog.parse({
        stdout: JSON.stringify({ models: [{ id: 'gpt-5.6-sol' }] }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toEqual({ kind: 'success', value: [{ id: 'gpt-5.6-sol', nativeOrder: 0 }] });
    // OpenCode and Kilo declare their native per-provider credential listing
    // as the auth probe; unparseable output falls back to bridged presence.
    expect(opencode.declared.auth).toMatchObject({
      kind: 'auth-status',
      command: ['opencode', 'providers', 'list'],
      cwd: 'neutral',
    });
    expect(kilo.declared.auth).toMatchObject({
      kind: 'auth-status',
      command: ['kilo', 'auth', 'list'],
      cwd: 'neutral',
    });
    if (opencode.declared.auth.kind === 'not-run' || kilo.declared.auth.kind === 'not-run') {
      throw new Error('expected provider oracle auth probes');
    }
    const oracleOutput = (stdout: string) => ({
      stdout,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      outputExceeded: false,
    });
    expect(
      kilo.declared.auth.parse(
        oracleOutput(
          '┌  Credentials ~/.local/share/kilo/auth.json\n│\n●  GitHub Copilot \u001b[90moauth\n│\n└  1 credentials\n',
        ),
      ),
    ).toBe('verified');
    expect(kilo.declared.auth.parse(oracleOutput('┌  Credentials\n│\n└  0 credentials\n'))).toBe(
      'missing',
    );
    expect(kilo.declared.auth.parse(oracleOutput('kilo: unknown command "auth"'))).toBe(
      'malformed',
    );
  });

  it('rejects Cursor before a readiness probe can be resolved', () => {
    expect(() => lookupCliPlannerAdapter('cursor')).toThrow(/has no planner configuration/);
    expect(() => lookupCliImplementerAdapter('cursor')).toThrow(/has no implementer configuration/);
  });
});
