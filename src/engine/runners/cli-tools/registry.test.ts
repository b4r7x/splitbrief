import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_CLI_ADMISSION_VERDICT,
  ANTIGRAVITY_CLI_CANDIDATE_PATHS,
  CLI_COMPILER_EVIDENCE,
  CLI_TOOL_IDS,
  CURSOR_CLI_ADMISSION_VERDICT,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../../core/runners/cli-tool-catalog.js';
import { resolveRepoPath as productionResolveRepoPath } from '../../../core/runners/candidate-admission.js';
import { COMPILER_SUPPORT_TABLE } from '../compiler-capability.js';
import {
  bindCompilerRuntimeEvidence,
  type CompilerRuntimeEvidence,
} from '../compiler-runtime-evidence.js';
import { resolveCustomExecutable } from '../resolve-cli-executable.js';
import {
  admitCliCompilerRuntime,
  CLI_IMPLEMENTER_ADAPTERS,
  CLI_PLANNER_ADAPTERS,
  lookupCliImplementerAdapter,
  lookupCliPlannerAdapter,
  lookupCliReadinessProbe,
} from './registry.js';
import { CODEX_NATIVE_MODEL_CATALOG_PROBE, codexPlannerAdapter } from './codex.js';
import { isDeclaredCliProbeContract } from './contract.js';
import {
  nativeCliCatalogToDetectedModels,
  parseCommandCodeNativeModelCatalog,
  parseCursorModels,
} from '../../providers/cli-model-catalog.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const REPO_ROOT = join(import.meta.dirname, '../../../..');
const CURSOR_LIST_MODELS_FIXTURE = readFileSync(
  join(REPO_ROOT, 'testing/fixtures/cursor/list-models.txt'),
  'utf8',
);
const CURSOR_LIST_MODELS_COUNT = CURSOR_LIST_MODELS_FIXTURE.split(/\r?\n/u).filter((line) =>
  /^\S+ - .+$/.test(line.trim()),
).length;
const COMMAND_CODE_LIST_MODELS_FIXTURE = readFileSync(
  join(REPO_ROOT, 'testing/fixtures/command-code/list-models.txt'),
  'utf8',
);
// Every CLI fixture opens with two provenance lines — the invocation and a
// `# version:` note — that the recorded process never printed.
const COMMAND_CODE_STATUS_FIXTURE = readFileSync(
  join(REPO_ROOT, 'testing/fixtures/command-code/status.txt'),
  'utf8',
)
  .split(/\r?\n/u)
  .slice(2)
  .join('\n');

const itUnix = process.platform === 'win32' ? it.skip : it;
let dirs: string[] = [];

function makeExecutable(path: string, body = '#!/bin/sh\nexit 0\n'): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

async function bindExactOpenCodeRuntime(): Promise<CompilerRuntimeEvidence> {
  const projectDir = createTempDir('registry-compiler-runtime-project');
  const binDir = createTempDir('registry-compiler-runtime-bin');
  dirs.push(projectDir, binDir);
  const executable = join(binDir, 'vendor-cli');
  makeExecutable(executable);
  const resolution = await resolveCustomExecutable({ command: executable, projectDir });
  if (resolution.kind !== 'resolved') throw new Error('fixture executable did not resolve');
  const admission = bindCompilerRuntimeEvidence({
    backend: 'opencode',
    executable: resolution.executable,
    version: '1.18.15',
  });
  if (admission.kind !== 'bound') throw new Error('fixture runtime did not bind');
  return admission.evidence;
}

function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

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

  it('keeps Cursor admitted in the catalog and Antigravity omitted until its adapter lands', () => {
    expect(CURSOR_CLI_ADMISSION_VERDICT).toBe('PASS');
    expect(ANTIGRAVITY_CLI_ADMISSION_VERDICT).toBe('OMIT');

    for (const relativePath of ANTIGRAVITY_CLI_CANDIDATE_PATHS) {
      expect(existsSync(resolveRepoPath(relativePath))).toBe(false);
    }

    expect(CLI_TOOL_IDS).toContain('cursor');
    expect(CLI_TOOL_IDS).toContain('command-code');
    expect('antigravity' in CLI_PLANNER_ADAPTERS).toBe(false);
    expect('antigravity' in CLI_IMPLEMENTER_ADAPTERS).toBe(false);
  });
});

describe('CLI registry lookup', () => {
  it('returns admitted planner adapters', () => {
    expect(lookupCliPlannerAdapter('codex')).toBe(CLI_PLANNER_ADAPTERS.codex);
  });

  it('returns admitted implementer adapters', () => {
    expect(lookupCliImplementerAdapter('opencode')).toBe(CLI_IMPLEMENTER_ADAPTERS.opencode);
  });

  it.each(['antigravity', 'kiro', 'unknown-cli'])(
    'rejects unsupported planner lookup for %s before spawn',
    (toolId) => {
      expect(() => lookupCliPlannerAdapter(toolId)).toThrow(/has no planner configuration/);
    },
  );

  it.each(['antigravity', 'kiro', 'unknown-cli'])(
    'rejects unsupported implementer lookup for %s before spawn',
    (toolId) => {
      expect(() => lookupCliImplementerAdapter(toolId)).toThrow(/has no implementer configuration/);
    },
  );
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
  });

  it('codex positive login status is verified', () => {
    const planner = lookupCliReadinessProbe({ tool: 'codex', role: 'planner' });
    expect(isDeclaredCliProbeContract(planner)).toBe(true);
    if (!isDeclaredCliProbeContract(planner)) throw new Error('expected declared Codex probe');
    if (planner.declared.auth.kind === 'not-run')
      throw new Error('expected Codex auth status probe');

    expect(
      planner.declared.auth.parse({
        stdout: 'Logged in using ChatGPT',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toBe('verified');
  });

  it.each([
    ['not logged in', 'missing'],
    ['expired', 'invalid'],
    ['forbidden', 'policy-denied'],
    ['network', 'offline'],
    ['no recognizable auth keywords', 'malformed'],
  ] as const)('codex negative login status maps %s to %s', (stdout, expected) => {
    const planner = lookupCliReadinessProbe({ tool: 'codex', role: 'planner' });
    expect(isDeclaredCliProbeContract(planner)).toBe(true);
    if (!isDeclaredCliProbeContract(planner)) throw new Error('expected declared Codex probe');
    if (planner.declared.auth.kind === 'not-run')
      throw new Error('expected Codex auth status probe');

    expect(
      planner.declared.auth.parse({
        stdout,
        stderr: '',
        exitCode: 1,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toBe(expected);
  });

  it.each([
    ['codex', 'codex-cli 0.40.0', { kind: 'success', value: '0.40.0' }],
    ['claude-code', '2.1.220 (Claude Code)', { kind: 'success', value: '2.1.220' }],
    ['copilot', 'GitHub Copilot CLI 1.0.77.', { kind: 'success', value: '1.0.77' }],
    ['opencode', '0.5.0', { kind: 'success', value: '0.5.0' }],
    ['kilo-code', '0.1.0', { kind: 'success', value: '0.1.0' }],
    ['codex', 'node 0.40.0', { kind: 'malformed' }],
    ['opencode', 'node 0.5.0', { kind: 'malformed' }],
    ['kilo-code', 'node 0.1.0', { kind: 'malformed' }],
    ['codex', 'node 99.0.0\ncodex-cli 0.40.0', { kind: 'malformed' }],
    ['opencode', 'node 99.0.0\n0.5.0', { kind: 'malformed' }],
    ['kilo-code', 'node 99.0.0\n0.1.0', { kind: 'malformed' }],
    ['codex', 'codex-cli 0.40.0\ncodex-cli 99.0.0', { kind: 'malformed' }],
    ['opencode', '0.5.0\n99.0.0', { kind: 'malformed' }],
    ['kilo-code', '0.1.0\n99.0.0', { kind: 'malformed' }],
    ['cursor', '2026.08.25-3e8eec8', { kind: 'success', value: '2026.08.25-3e8eec8' }],
    ['cursor', '1.2.3', { kind: 'malformed' }],
    ['cursor', 'node 2026.08.25-3e8eec8', { kind: 'malformed' }],
    ['cursor', '2026.08.25-3e8eec8\n2026.09.01-abc', { kind: 'malformed' }],
    ['command-code', '1.39.2', { kind: 'success', value: '1.39.2' }],
    ['command-code', 'cmd 1.39.2', { kind: 'malformed' }],
    ['command-code', '1.39.2\n2.0.0', { kind: 'malformed' }],
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
    const opencode = lookupCliReadinessProbe({ tool: 'opencode', role: 'planner' });
    const kilo = lookupCliReadinessProbe({ tool: 'kilo-code', role: 'planner' });
    const codex = lookupCliReadinessProbe({ tool: 'codex', role: 'planner' });

    expect(isDeclaredCliProbeContract(opencode)).toBe(true);
    expect(isDeclaredCliProbeContract(kilo)).toBe(true);
    expect(isDeclaredCliProbeContract(codex)).toBe(true);
    if (
      !isDeclaredCliProbeContract(opencode) ||
      !isDeclaredCliProbeContract(kilo) ||
      !isDeclaredCliProbeContract(codex)
    ) {
      throw new Error('expected admitted declared probes');
    }

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

  it('binds Cursor to declared version, auth, and catalog probes', () => {
    const planner = lookupCliReadinessProbe({ tool: 'cursor', role: 'planner' });
    const implementer = lookupCliReadinessProbe({ tool: 'cursor', role: 'implementer' });

    expect(planner).toBe(CLI_PLANNER_ADAPTERS.cursor.probe);
    expect(implementer).toBe(CLI_IMPLEMENTER_ADAPTERS.cursor.probe);
    expect(isDeclaredCliProbeContract(planner)).toBe(true);
    if (!isDeclaredCliProbeContract(planner)) throw new Error('expected declared Cursor probe');

    expect(planner.declared.version.command).toEqual(['cursor-agent', '--version']);
    expect(planner.declared.auth).toMatchObject({
      kind: 'auth-status',
      command: ['cursor-agent', 'status'],
      cwd: 'neutral',
    });
    expect(planner.declared.catalog).toMatchObject({
      kind: 'catalog',
      command: ['cursor-agent', '--list-models'],
    });
    if (planner.declared.auth.kind === 'not-run' || planner.declared.catalog.kind === 'not-run') {
      throw new Error('expected Cursor auth and catalog probes');
    }

    expect(
      planner.declared.auth.parse({
        stdout: '✓ Logged in as operator@example.com',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toBe('verified');
    expect(
      planner.declared.catalog.parse({
        stdout: CURSOR_LIST_MODELS_FIXTURE,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toEqual({ kind: 'success', value: parseCursorModels(CURSOR_LIST_MODELS_FIXTURE) });
  });

  it('binds Command Code to declared version, auth, and catalog probes', () => {
    const planner = lookupCliReadinessProbe({ tool: 'command-code', role: 'planner' });
    const implementer = lookupCliReadinessProbe({ tool: 'command-code', role: 'implementer' });

    expect(planner).toBe(CLI_PLANNER_ADAPTERS['command-code'].probe);
    expect(implementer).toBe(CLI_IMPLEMENTER_ADAPTERS['command-code'].probe);
    expect(isDeclaredCliProbeContract(planner)).toBe(true);
    if (!isDeclaredCliProbeContract(planner))
      throw new Error('expected declared Command Code probe');

    expect(planner.declared.version.command).toEqual(['cmd', '--version']);
    expect(planner.declared.auth).toMatchObject({
      kind: 'auth-status',
      command: ['cmd', 'status', '--json'],
      cwd: 'neutral',
    });
    expect(planner.declared.catalog).toMatchObject({
      kind: 'catalog',
      command: ['cmd', '--list-models'],
    });
    if (planner.declared.catalog.kind === 'not-run') {
      throw new Error('expected Command Code catalog probe');
    }

    const catalog = parseCommandCodeNativeModelCatalog(COMMAND_CODE_LIST_MODELS_FIXTURE);
    if (catalog === null) throw new Error('command code list-models fixture failed to parse');

    expect(
      planner.declared.catalog.parse({
        stdout: COMMAND_CODE_LIST_MODELS_FIXTURE,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toEqual({
      kind: 'success',
      value: nativeCliCatalogToDetectedModels(catalog),
    });
  });

  it('treats a Command Code exit code 3 as missing and the recorded status payload as verified', () => {
    const planner = lookupCliReadinessProbe({ tool: 'command-code', role: 'planner' });
    expect(isDeclaredCliProbeContract(planner)).toBe(true);
    if (!isDeclaredCliProbeContract(planner))
      throw new Error('expected declared Command Code probe');
    if (planner.declared.auth.kind === 'not-run') {
      throw new Error('expected Command Code auth probe');
    }

    expect(
      planner.declared.auth.parse({
        stdout: '',
        stderr: 'Not authenticated',
        exitCode: 3,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toBe('missing');
    expect(
      planner.declared.auth.parse({
        stdout: COMMAND_CODE_STATUS_FIXTURE,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toBe('verified');
  });

  it.each(['claude-code', 'codex', 'cursor', 'command-code'] as const)(
    'reads a negated %s status line as missing, not verified',
    (tool) => {
      const planner = lookupCliReadinessProbe({ tool, role: 'planner' });
      expect(isDeclaredCliProbeContract(planner)).toBe(true);
      if (!isDeclaredCliProbeContract(planner)) throw new Error(`expected declared ${tool} probe`);
      if (planner.declared.auth.kind === 'not-run') {
        throw new Error(`expected ${tool} auth probe`);
      }

      for (const stderr of ['Not authenticated', 'Not signed in', 'No active session']) {
        expect(
          planner.declared.auth.parse({
            stdout: '',
            stderr,
            exitCode: 1,
            timedOut: false,
            outputExceeded: false,
          }),
        ).toBe('missing');
      }
    },
  );

  it.each([
    {
      name: '✓ Logged in as invalid@x.com → verified',
      stdout: '✓ Logged in as invalid@x.com',
      expected: 'verified',
    },
    { name: 'signed-out → missing', stdout: 'Not logged in', expected: 'missing' },
  ] as const)('$name', ({ stdout, expected }) => {
    const planner = lookupCliReadinessProbe({ tool: 'cursor', role: 'planner' });
    expect(isDeclaredCliProbeContract(planner)).toBe(true);
    if (!isDeclaredCliProbeContract(planner)) throw new Error('expected declared Cursor probe');
    if (planner.declared.auth.kind === 'not-run') {
      throw new Error('expected Cursor auth probe');
    }

    expect(
      planner.declared.auth.parse({
        stdout,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      }),
    ).toBe(expected);
  });

  it(`cursor model list fixture parses to ${CURSOR_LIST_MODELS_COUNT} models`, () => {
    const models = parseCursorModels(CURSOR_LIST_MODELS_FIXTURE);
    expect(models).not.toBeNull();
    expect(models).toHaveLength(CURSOR_LIST_MODELS_COUNT);
    expect(
      models?.some((model) => model.id === 'Available models' || model.id.startsWith('Tip')),
    ).toBe(false);
  });

  it('unrecognisable model output returns null', () => {
    expect(parseCursorModels('Usage: cursor-agent --list-models')).toBeNull();
    expect(parseCursorModels('Available models\n\n')).toBeNull();
    expect(parseCursorModels('')).toBeNull();
  });
});

describe('CLI compiler support rows', () => {
  it('covers every catalogued tool and requires a runtime version exactly when supported', () => {
    expect(Object.keys(CLI_COMPILER_EVIDENCE)).toEqual([...CLI_TOOL_IDS]);
    for (const id of CLI_TOOL_IDS) {
      const evidence = CLI_COMPILER_EVIDENCE[id];
      const row = COMPILER_SUPPORT_TABLE[id];
      const supported = evidence.state !== 'unsupported';
      expect({ tool: id, versionRequired: row.versionRequired }).toEqual({
        tool: id,
        versionRequired: supported,
      });
      expect({ tool: id, containable: row.containmentProfiles.length > 0 }).toEqual({
        tool: id,
        containable: supported,
      });
      expect({ tool: id, credentialed: row.credentialChannels.length > 0 }).toEqual({
        tool: id,
        credentialed: supported,
      });
    }
  });
});

describe('admitCliCompilerRuntime', () => {
  itUnix('admits the bound exact runtime through the catalog evidence identity', async () => {
    const runtime = await bindExactOpenCodeRuntime();

    const admission = admitCliCompilerRuntime({ tool: 'opencode', runtime });

    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(admission.evidence).toBe(CLI_COMPILER_EVIDENCE.opencode);
  });

  itUnix('admits drifted evidence for supported tools', async () => {
    const runtime = await bindExactOpenCodeRuntime();
    const driftedRuntime: CompilerRuntimeEvidence = {
      ...runtime,
      runtimeVersion: '1.18.16',
      versionObservation: 'drifted',
    };

    const admission = admitCliCompilerRuntime({ tool: 'opencode', runtime: driftedRuntime });

    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') return;
    expect(admission.evidence).toBe(CLI_COMPILER_EVIDENCE.opencode);
  });

  itUnix('refuses a forward runtime version before readiness', async () => {
    const runtime = await bindExactOpenCodeRuntime();

    const admission = admitCliCompilerRuntime({
      tool: 'opencode',
      runtime: { ...runtime, version: '1.18.16' },
    });

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
    expect(admission.missing).toEqual(['version']);
  });

  itUnix(
    'refuses protocol, fixture, transport, and backend drift against the catalog',
    async () => {
      const runtime = await bindExactOpenCodeRuntime();
      const rows: Array<{
        override: Partial<CompilerRuntimeEvidence>;
        missing: readonly string[];
      }> = [
        {
          override: { terminalContract: 'opencode-final-message-v2' },
          missing: ['terminalContract'],
        },
        { override: { fixtureDate: '2026-08-14' }, missing: ['fixtureDate'] },
        { override: { transports: ['declared-file'] }, missing: ['transport'] },
        { override: { backend: 'codex' }, missing: ['backend'] },
      ];

      for (const { override, missing } of rows) {
        const admission = admitCliCompilerRuntime({
          tool: 'opencode',
          runtime: { ...runtime, ...override },
        });

        expect(admission.kind).toBe('refused');
        if (admission.kind !== 'refused') continue;
        expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
        expect(admission.missing).toEqual(missing);
      }
    },
  );

  itUnix.each(['copilot', 'cursor'] as const)(
    'refuses the loader-only %s adapter even with exact claimed evidence',
    async (tool) => {
      const runtime = await bindExactOpenCodeRuntime();

      const admission = admitCliCompilerRuntime({
        tool,
        runtime: { ...runtime, backend: tool },
      });

      expect(admission.kind).toBe('refused');
      if (admission.kind !== 'refused') return;
      expect(admission.failure.code).toBe('task_compiler_capability_unsupported');
      expect(admission.missing).toEqual(['backend']);
      expect(admission.failure.message).toContain(tool);
    },
  );
});
