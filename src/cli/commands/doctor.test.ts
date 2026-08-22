import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import {
  deriveCliReadiness,
  READINESS_DIAGNOSTIC_STATE_IDS,
  type CliReadinessResult,
  type ReadinessDiagnosticStateId,
} from '../../core/schemas/readiness.js';
import {
  deriveReadinessDiagnosticState,
  formatReadinessReport,
  READINESS_DIAGNOSTIC_REMEDIATION,
  readinessCheckRemediation,
  serializeReadinessReportJson,
} from '../../core/readiness/format.js';
import type { RunnerAvailabilityFact } from '../../core/readiness/checks/availability.js';
import type { ReadinessCheck } from '../../core/readiness/types.js';
import { isCliError } from '../errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import type { RunnerEvidence } from '../../core/discovery/runner-evidence.js';
import { runnerDiscoveryContextKey } from '../../engine/detection/detect.js';
import { collectRunnerAdmissionChecks } from '../../engine/runners/prepare-execution.js';
import { registerDoctorCommand } from './doctor.js';

const EXECUTABLE_DIGEST = 'a'.repeat(64);
const codexExecutable = CliExecutableReceiptSchema.parse({
  path: '/usr/local/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  executableIdentity: {
    canonicalPath: '/usr/local/bin/codex',
    realPath: '/usr/local/bin/codex',
    platformFileId: '1:2',
    fingerprint: `1:2:3:4:sha256:${EXECUTABLE_DIGEST}`,
    resolvedAt: 1,
  },
});

function freshCodexEvidence(
  context: Parameters<typeof runnerDiscoveryContextKey>[0],
  overrides: Partial<Pick<RunnerEvidence, 'auth'>> = {},
): RunnerEvidence {
  const key = runnerDiscoveryContextKey(context);
  const testedVersion = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;
  return {
    runner: { id: 'codex', kind: 'cli', locality: 'local', enabled: 'enabled' },
    context: { key, observedAt: 1, source: 'fresh' },
    installation: 'installed',
    executable: {
      kind: 'trusted',
      identity: codexExecutable.executableIdentity,
    },
    compatibility: { kind: 'compatible', installedVersion: testedVersion, testedVersion },
    credential: 'present',
    auth: overrides.auth ?? 'verified',
    endpoint: { kind: 'not-run' },
    catalog: { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: context.model ?? 'unselected',
      observedAt: 1,
      contextKey: key,
    },
  };
}

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('doctor-command-test');
});

afterEach(() => {
  cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

function initGitRepo(projectDir: string): void {
  execSync('git init', { cwd: projectDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: projectDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: projectDir, stdio: 'pipe' });
  writeFileSync(join(projectDir, '.gitkeep'), '');
  execSync('git add .gitkeep', { cwd: projectDir, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: projectDir, stdio: 'pipe' });
}

function initGitRepoWithoutCommit(projectDir: string): void {
  execSync('git init', { cwd: projectDir, stdio: 'pipe' });
}

function writeConfig(projectDir: string, content = validConfigYaml()): string {
  const splitbriefDir = join(projectDir, SPLITBRIEF_DIR);
  mkdirSync(splitbriefDir, { recursive: true });
  const filePath = join(splitbriefDir, CONFIG_FILE);
  writeFileSync(filePath, content);
  return filePath;
}

function validConfigYaml(): string {
  return [
    'version: 3',
    'planner:',
    '  kind: cli',
    '  tool: claude-code',
    'implementer:',
    '  kind: api',
    '  provider: ollama',
    '  apiBase: http://localhost:11434/v1',
    '  model: qwen2.5-coder:7b',
    '  contextLength: 32768',
    'validation:',
    '  typecheck: true',
    '  lint: false',
    '  test: true',
    '  testCommand: npm test',
    'workflow:',
    '  approve: default',
    '  maxRetries: 3',
    '  persistTranscript: true',
    '  mode: quick',
  ].join('\n');
}

function deterministicCliReadiness(): readonly CliReadinessResult[] {
  return [
    deriveCliReadiness({
      tool: 'claude-code',
      enabled: true,
      installation: 'installed',
      executable: {
        path: '/usr/local/bin/claude',
        fingerprint: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
      },
      trust: 'trusted',
      installedVersion: CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion,
      testedVersion: CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion,
      compatibility: 'compatible',
      auth: 'authenticated',
      probedAt: 1,
    }),
  ];
}

async function runDoctor(
  args: string[],
  detectCliReadiness: () => Promise<readonly CliReadinessResult[]> = async () =>
    deterministicCliReadiness(),
  runArgVectorHelp: () => Promise<string | null> = async () => null,
  // Availability is a live network claim; unit runs make none unless they say so.
  probeRunnerAvailability: () => Promise<readonly RunnerAvailabilityFact[]> = async () => [],
  collectAdmissionChecks: typeof collectRunnerAdmissionChecks = collectRunnerAdmissionChecks,
): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerDoctorCommand(program, {
    detectCliReadiness,
    runArgVectorHelp,
    probeRunnerAvailability,
    collectRunnerAdmissionChecks: collectAdmissionChecks,
  });
  await program.parseAsync(['node', 'splitbrief', 'doctor', ...args]);
}

function captureStdout(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

interface DoctorJsonCheck {
  id: string;
  severity: ReadinessCheck['severity'];
  summary: string;
  modelSelection?: string;
}

async function doctorJsonChecks(configYaml: string): Promise<DoctorJsonCheck[]> {
  writeConfig(tmp, configYaml);
  const writes = captureStdout();
  await runDoctor(['--project', tmp, '--json']);
  const parsed = JSON.parse(writes.join('').trim()) as {
    report?: { checks?: DoctorJsonCheck[] };
  };
  return parsed.report?.checks ?? [];
}

// An older `claude` whose help advertises every long flag the planner emits
// except --include-partial-messages.
const CLAUDE_HELP_WITHOUT_PARTIAL_MESSAGES = [
  'Usage: claude [options] [command] [prompt]',
  '',
  'Options:',
  '  -p, --print                Print response and exit',
  '  --output-format <format>   Output format: text, json, stream-json',
  '  --verbose                  Override verbose mode',
  '  -r, --resume [sessionId]   Resume a conversation by session ID',
  '  --permission-mode <mode>   Permission mode for the session',
  '  -h, --help                 Display help for command',
].join('\n');

function syntheticCheck(
  stateId: ReadinessDiagnosticStateId,
  overrides: Partial<ReadinessCheck> = {},
): ReadinessCheck {
  return {
    id: overrides.id ?? `diagnostic.${stateId}`,
    severity: overrides.severity ?? 'blocker',
    summary: overrides.summary ?? `Diagnostic ${stateId}`,
    diagnosticState: stateId,
    ...overrides,
  };
}

describe('readiness diagnostic states', () => {
  it.each(READINESS_DIAGNOSTIC_STATE_IDS)(
    'maps %s to a stable state ID and copyable remediation',
    (stateId) => {
      const check = syntheticCheck(stateId);
      expect(deriveReadinessDiagnosticState(check)).toBe(stateId);
      expect(readinessCheckRemediation(check)).toBe(READINESS_DIAGNOSTIC_REMEDIATION[stateId]);
    },
  );

  it.each([
    ['endpoint-invalid', 'provider-endpoint-invalid: host not allowed'],
    ['credential-family-mismatch', 'provider-credential-prefix-mismatch for sk-ant-'],
    ['protocol-failure', 'protocol-failure: missing terminal result'],
    ['quota-rate-limit', 'HTTP 429 rate limit exceeded'],
    ['conflicting-args', 'conflicting-args: --model and --agent'],
  ] as const)('classifies %s from a quoted machine token', (stateId, detail) => {
    const check: ReadinessCheck = {
      id: 'runners.failure',
      severity: 'blocker',
      summary: 'Runner failed',
      details: [detail],
    };
    expect(deriveReadinessDiagnosticState(check)).toBe(stateId);
    expect(readinessCheckRemediation(check)).toBe(READINESS_DIAGNOSTIC_REMEDIATION[stateId]);
  });

  it.each([
    'Provider endpoint policy rejected the configured host',
    'The credential family does not match the declared provider',
    'The runner produced no terminal result line',
    'Provider quota exhausted; try again later',
    'conflicting args: --model and --agent',
  ])('does not classify prose without a machine token (%s)', (detail) => {
    const check: ReadinessCheck = {
      id: 'runners.failure',
      severity: 'blocker',
      summary: 'Runner failed',
      details: [detail],
    };
    expect(deriveReadinessDiagnosticState(check)).toBeNull();
    expect(readinessCheckRemediation(check)).toBeNull();
  });
});

describe('doctor command', () => {
  it('prints human readiness without creating workflow artifacts', async () => {
    initGitRepo(tmp);
    const configFile = writeConfig(tmp);
    const beforeConfig = readFileSync(configFile, 'utf-8');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDoctor(['--project', tmp]);

    const output = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Run readiness:');
    expect(output).toContain('Config:');
    expect(output).toContain('Repository:');
    expect(output).toContain('warning validation.disabled');
    expect(readFileSync(configFile, 'utf-8')).toBe(beforeConfig);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'active'))).toBe(false);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
  });

  it('emits JSON with warning and info severities', async () => {
    initGitRepo(tmp);
    writeConfig(tmp);
    const writes = captureStdout();

    await runDoctor(['--project', tmp, '--json']);

    const parsed = JSON.parse(writes.join('').trim()) as {
      type?: string;
      report?: { checks?: Array<{ severity: string }> };
    };
    const severities = parsed.report?.checks?.map((check) => check.severity) ?? [];
    expect(parsed.type).toBe('readiness_report');
    expect(severities).toContain('warning');
    expect(severities).toContain('info');
  });

  it('fails with an actionable blocker when the default implementer is unreachable', async () => {
    initGitRepo(tmp);
    writeConfig(tmp);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const failure = await runDoctor(['--project', tmp], undefined, undefined, async () => [
      {
        slot: { role: 'implementer', profile: 'default' },
        provider: 'ollama',
        endpoint: 'http://localhost:11434/v1',
        verdict: { state: 'unavailable', diagnostic: 'fetch failed' },
      },
    ]).catch((err: unknown) => err);

    const output = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain(
      'blocker runners.availability.implementer.default: Default implementer ollama (qwen2.5-coder:7b) is not reachable at http://localhost:11434/v1.',
    );
    expect(output).toContain(
      'Fix: Run `ollama serve`, or configure a different implementer, then run `splitbrief doctor` again.',
    );
    expect(isCliError(failure)).toBe(true);
    expect(toErrorMessage(failure)).toContain('runners.availability.implementer.default');
  });

  it('runs no validation command without --probe-validation', async () => {
    initGitRepo(tmp);
    writeConfig(
      tmp,
      validConfigYaml().replace(
        '  testCommand: npm test',
        '  testCommand: node -e "process.exit(1)"',
      ),
    );
    const writes = captureStdout();

    await runDoctor(['--project', tmp, '--json']);

    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: Array<{ id: string }> };
    };
    expect(parsed.report?.checks?.map((check) => check.id)).not.toContain(
      'validation.already-failing',
    );
  });

  it('--probe-validation reports a stage that already fails and names the command it ran', async () => {
    initGitRepo(tmp);
    writeConfig(
      tmp,
      validConfigYaml().replace(
        '  testCommand: npm test',
        '  testCommand: node -e "process.exit(1)"',
      ),
    );
    const writes = captureStdout();

    await runDoctor(['--project', tmp, '--json', '--probe-validation']);

    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: Array<{ id: string; summary: string; details?: string[] }> };
    };
    const probe = parsed.report?.checks?.find((check) => check.id === 'validation.already-failing');
    expect(probe?.summary).toContain('test');
    expect(probe?.details?.[0]).toContain('test: node -e "process.exit(1)"');
    expect(probe?.details?.[1]).toContain('pre-run commands');
  });

  it('lists --probe-validation in help', async () => {
    const program = new Command();
    program.exitOverride();
    registerDoctorCommand(program);
    const writes = captureStdout();

    await program.parseAsync(['node', 'splitbrief', 'doctor', '--help']).catch(() => undefined);

    expect(writes.join('')).toContain('--probe-validation');
  });

  it('reports automatic CLI model selection as auto, not as an unset model', async () => {
    initGitRepo(tmp);
    const checks = await doctorJsonChecks(
      validConfigYaml().replace('  tool: claude-code', '  tool: claude-code\n  model: auto'),
    );

    const planner = checks.find((check) => check.id === 'runners.planner.configured');
    expect(planner?.summary).toContain('claude-code (auto)');
    expect(planner?.modelSelection).toBe('auto');

    const implementer = checks.find((check) => check.id === 'runners.implementer.default');
    expect(implementer?.summary).toContain('ollama (qwen2.5-coder:7b)');
  });

  it.each([
    { label: 'an explicit model', model: '\n  model: opus', expected: 'explicit' },
    { label: 'no model key', model: '', expected: 'unset' },
  ])(
    'publishes $label as a JSON model selection distinct from auto',
    async ({ model, expected }) => {
      initGitRepo(tmp);
      const checks = await doctorJsonChecks(
        validConfigYaml().replace('  tool: claude-code', `  tool: claude-code${model}`),
      );

      const planner = checks.find((check) => check.id === 'runners.planner.configured');
      expect(planner?.modelSelection).toBe(expected);
      expect(planner?.summary).not.toContain('(auto)');
    },
  );

  it('doctor readiness for a config denied headless admission contains a `runners.preparation.` check whose remediation names `--allow-unverified-auth`', async () => {
    initGitRepo(tmp);
    writeConfig(
      tmp,
      validConfigYaml().replace('  tool: claude-code', '  tool: codex\n  authChannel: session'),
    );
    const writes = captureStdout();

    let captured: unknown;
    try {
      await runDoctor(
        ['--project', tmp, '--json'],
        async () => [
          deriveCliReadiness({
            tool: 'codex',
            enabled: true,
            installation: 'installed',
            executable: {
              path: codexExecutable.path,
              fingerprint: codexExecutable.fingerprint,
            },
            trust: 'trusted',
            installedVersion: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
            testedVersion: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
            compatibility: 'compatible',
            auth: 'unknown',
            probedAt: 1,
          }),
        ],
        async () => null,
        async () => [],
        async (input) =>
          collectRunnerAdmissionChecks({
            ...input,
            deps: {
              detectRunnerEvidence: async ({ context }) =>
                freshCodexEvidence(context, { auth: 'unknown' }),
              resolveCliExecutableAliases: async () => ({
                command: 'codex',
                executable: codexExecutable,
                usedFallback: false,
              }),
            },
          }),
      );
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: Array<{ id: string; remediation?: string | null }> };
    };
    const preparationCheck = parsed.report?.checks?.find((check) =>
      check.id.startsWith('runners.preparation.'),
    );
    expect(preparationCheck).toBeDefined();
    expect(preparationCheck?.remediation).toContain('--allow-unverified-auth');
  });

  it('emits JSON and exits non-zero for missing config without writing setup files', async () => {
    initGitRepo(tmp);
    const writes = captureStdout();

    let captured: unknown;
    try {
      await runDoctor(['--project', tmp, '--json']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode: number }).exitCode).toBe(1);
    const parsed = JSON.parse(writes.join('').trim()) as {
      type?: string;
      report?: { status?: string; nextAction?: { kind?: string } };
    };
    expect(parsed.type).toBe('readiness_report');
    expect(parsed.report?.status).toBe('blocked');
    expect(parsed.report?.nextAction?.kind).toBe('run-init');
    expect(existsSync(join(tmp, SPLITBRIEF_DIR))).toBe(false);
  });

  it('reports invalid config as a blocker without rewriting it', async () => {
    initGitRepo(tmp);
    const badConfig = [
      'version: 3',
      'planner:',
      '  kind: cli',
      '  tool: not-a-tool',
      'implementer:',
      '  kind: api',
      '  provider: ollama',
      '  apiBase: http://localhost:11434/v1',
      '  model: qwen2.5-coder:7b',
    ].join('\n');
    const configFile = writeConfig(tmp, badConfig);
    const writes = captureStdout();

    let captured: unknown;
    try {
      await runDoctor(['--project', tmp, '--json']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { status?: string; checks?: Array<{ id: string }> };
    };
    expect(parsed.report?.status).toBe('blocked');
    expect(parsed.report?.checks?.map((check) => check.id)).toContain('config.invalid');
    expect(readFileSync(configFile, 'utf-8')).toBe(badConfig);
  });

  it('names a removed workflow key on its own detail line', async () => {
    initGitRepo(tmp);
    writeConfig(tmp, `${validConfigYaml()}\n  auto_approve_spec: true`);
    const writes = captureStdout();

    let captured: unknown;
    try {
      await runDoctor(['--project', tmp, '--json']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: Array<{ id: string; details?: string[] }> };
    };
    const invalid = parsed.report?.checks?.find((check) => check.id === 'config.invalid');
    expect(invalid?.details).toContainEqual(
      expect.stringContaining('workflow.autoApproveSpec: Unknown config key'),
    );
  });

  it('renders each blocker on its own line in the CLI error message', async () => {
    const badConfig = [
      'version: 3',
      'planner:',
      '  kind: cli',
      '  tool: not-a-tool',
      'implementer:',
      '  kind: api',
      '  provider: ollama',
      '  apiBase: http://localhost:11434/v1',
      '  model: qwen2.5-coder:7b',
    ].join('\n');
    writeConfig(tmp, badConfig);
    captureStdout();

    let captured: unknown;
    try {
      await runDoctor(['--project', tmp]);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const rendered = toErrorMessage(captured, { preserveLineBreaks: true });
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('config.invalid');
    expect(lines[1]).toContain('repo.not-git');
  });

  it('reports a non-git project as blocked', async () => {
    writeConfig(tmp);
    const writes = captureStdout();

    let captured: unknown;
    try {
      await runDoctor(['--project', tmp, '--json']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: Array<{ id: string }> };
    };
    expect(parsed.report?.checks?.map((check) => check.id)).toContain('repo.not-git');
  });

  it('reports a zero-commit repository as blocked', async () => {
    initGitRepoWithoutCommit(tmp);
    writeConfig(tmp);
    const writes = captureStdout();

    let captured: unknown;
    try {
      await runDoctor(['--project', tmp, '--json']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { status?: string; checks?: Array<{ id: string }> };
    };
    expect(parsed.report?.status).toBe('blocked');
    expect(parsed.report?.checks?.map((check) => check.id)).toContain('repo.no-commits');
  });

  it('reports endpoint-invalid in JSON for a config with a bad apiBase protocol', async () => {
    initGitRepo(tmp);
    writeConfig(
      tmp,
      [
        'version: 3',
        'planner:',
        '  kind: cli',
        '  tool: claude-code',
        'implementer:',
        '  kind: api',
        '  provider: ollama',
        '  apiBase: ftp://localhost:11434/v1',
        '  model: qwen2.5-coder:7b',
      ].join('\n'),
    );
    const writes = captureStdout();

    let captured: unknown;
    try {
      await runDoctor(['--project', tmp, '--json']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: Array<{ stateId?: string; remediation?: string }> };
    };
    const endpointCheck = parsed.report?.checks?.find(
      (check) => check.stateId === 'endpoint-invalid',
    );
    expect(endpointCheck?.stateId).toBe('endpoint-invalid');
    expect(endpointCheck?.remediation).toBeTruthy();
  });

  it.each([
    ['missing-binary', { installation: 'unavailable' as const, executable: null }],
    ['untrusted-path', { trust: 'untrusted' as const }],
    ['incompatible-version', { compatibility: 'incompatible' as const }],
    ['unauthenticated', { auth: 'unauthenticated' as const }],
    ['auth-unknown', { auth: 'unknown' as const }],
  ] as const)(
    'emits JSON stateId %s and human next action for CLI readiness',
    async (stateId, overrides) => {
      initGitRepo(tmp);
      writeConfig(tmp);
      const writes = captureStdout();
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const cliResult = deriveCliReadiness({
        tool: 'claude-code',
        enabled: true,
        installation: 'installed',
        executable: {
          path: '/usr/local/bin/claude',
          fingerprint: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
        },
        trust: 'trusted',
        installedVersion: '2.0.0',
        testedVersion: '2.0.0',
        compatibility: 'compatible',
        auth: 'authenticated',
        probedAt: 1,
        ...overrides,
      });

      let captured: unknown;
      try {
        await runDoctor(['--project', tmp, '--json'], async () => [cliResult]);
      } catch (err) {
        captured = err;
      }

      if (stateId !== 'auth-unknown') {
        expect(isCliError(captured)).toBe(true);
      }

      const parsed = JSON.parse(writes.join('').trim()) as {
        report?: {
          checks?: Array<{
            id: string;
            stateId?: string | null;
            remediation?: string | null;
          }>;
        };
      };
      const readinessCheck = parsed.report?.checks?.find(
        (check) => check.id === 'runners.cli.claude-code.readiness',
      );
      expect(readinessCheck?.stateId).toBe(stateId);
      expect(readinessCheck?.remediation).toBeTruthy();

      writes.length = 0;
      consoleSpy.mockClear();
      try {
        await runDoctor(['--project', tmp], async () => [cliResult]);
      } catch {
        // blocked readiness exits non-zero after printing human output
      }
      const human = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(human).toContain('Fix:');
      expect(human).toContain(readinessCheck?.remediation ?? '');
      expect(human.includes('\u001b')).toBe(false);
      expect(human.includes('\u0007')).toBe(false);
    },
    20_000,
  );

  // A CLI readiness the probe could not verify stays a warning — doctor
  // diagnoses, it does not decide — but start refuses it, so the summary must
  // not promise the operator that start can continue.
  it('reports an unverified CLI readiness as a warning that still blocks start', async () => {
    initGitRepo(tmp);
    writeConfig(tmp);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const unverified = deriveCliReadiness({
      tool: 'claude-code',
      enabled: true,
      installation: 'installed',
      executable: {
        path: '/usr/local/bin/claude',
        fingerprint: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
      },
      trust: 'trusted',
      installedVersion: CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion,
      testedVersion: CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion,
      compatibility: 'compatible',
      auth: 'unknown',
      probedAt: 1,
    });

    await runDoctor(['--project', tmp], async () => [unverified]);

    const human = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(unverified.status).toBe('unverified');
    expect(human).toContain('Run readiness: ready-with-warnings');
    expect(human).not.toContain('start can continue');
    expect(human).toContain('No trusted readiness identity for claude-code');
    expect(human).toContain('--allow-unverified-auth');
    expect(human).toContain(unverified.remediation ?? '');
  });

  it('blocks on an emitted flag the installed binary does not advertise', async () => {
    initGitRepo(tmp);
    writeConfig(tmp);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let captured: unknown;
    try {
      await runDoctor(
        ['--project', tmp],
        undefined,
        async () => CLAUDE_HELP_WITHOUT_PARTIAL_MESSAGES,
      );
    } catch (err) {
      captured = err;
    }

    const human = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const argVectorLine = human
      .split('\n')
      .find((line) => line.includes('runners.cli.claude-code.arg-vector.planner'));
    expect(argVectorLine).toContain('blocker');
    expect(argVectorLine).toContain('does not support: --include-partial-messages.');
    expect(isCliError(captured)).toBe(true);
    expect(toErrorMessage(captured)).toContain('runners.cli.claude-code.arg-vector.planner');
  });

  it('reports no arg-vector blocker when the installed binary yields no help text', async () => {
    initGitRepo(tmp);

    const checks = await doctorJsonChecks(validConfigYaml());

    const argVector = checks.find(
      (check) => check.id === 'runners.cli.claude-code.arg-vector.planner',
    );
    expect(argVector?.severity).toBe('ok');
    expect(argVector?.summary).toContain('could not be compared');
    expect(checks.map((check) => check.id)).toContain('runners.cli.claude-code.readiness');
  });

  it('serializes semantic JSON without decorative section layout or secrets', async () => {
    initGitRepo(tmp);
    writeConfig(tmp);
    const secretPath = '/Users/private-user/project/bin/claude';
    const cliResult = deriveCliReadiness({
      tool: 'claude-code',
      enabled: true,
      installation: 'installed',
      executable: {
        path: secretPath,
        fingerprint: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
      },
      trust: 'trusted',
      installedVersion: CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion,
      testedVersion: CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion,
      compatibility: 'compatible',
      auth: 'authenticated',
      probedAt: 1,
    });
    const writes = captureStdout();

    await runDoctor(['--project', tmp, '--json'], async () => [cliResult]);

    const raw = writes.join('').trim();
    expect(raw).not.toContain(secretPath);
    const parsed = JSON.parse(raw) as {
      report?: {
        sections?: unknown;
        checks?: Array<{ stateId?: string | null; remediation?: string | null }>;
      };
    };
    expect(parsed.report?.sections).toBeUndefined();
    expect(parsed.report?.checks?.some((check) => check.stateId === null)).toBe(true);
    expect(raw).not.toMatch(/Config:|Repository:/);
  });

  it('keeps provider and protocol diagnostics stable in serialized JSON', () => {
    const report = serializeReadinessReportJson({
      generatedAt: '2026-01-01T00:00:00.000Z',
      projectDir: '/tmp/project',
      status: 'blocked',
      counts: { ok: 0, info: 0, warning: 0, blocker: 3 },
      nextAction: {
        kind: 'fix-config',
        label: 'Fix config',
        reason: 'Blocked',
      },
      sections: [
        {
          id: 'runners',
          title: 'Runners',
          checks: [
            syntheticCheck('credential-family-mismatch', {
              details: ['provider-credential-prefix-mismatch'],
            }),
            syntheticCheck('protocol-failure', { details: ['protocol-failure: missing terminal'] }),
            syntheticCheck('quota-rate-limit', { details: ['HTTP 429 rate limit exceeded'] }),
            syntheticCheck('conflicting-args', { details: ['conflicting args for --model'] }),
          ],
        },
      ],
      metadata: {},
    });

    expect(report.checks.map((check) => check.stateId)).toEqual([
      'credential-family-mismatch',
      'protocol-failure',
      'quota-rate-limit',
      'conflicting-args',
    ]);
    for (const check of report.checks) {
      expect(check.remediation).toBe(
        READINESS_DIAGNOSTIC_REMEDIATION[check.stateId as ReadinessDiagnosticStateId],
      );
    }
    expect(
      formatReadinessReport({
        generatedAt: report.generatedAt,
        projectDir: report.projectDir,
        status: report.status,
        counts: report.counts,
        nextAction: report.nextAction,
        sections: [
          {
            id: 'runners',
            title: 'Runners',
            checks: report.checks.map((check) => ({
              id: check.id,
              severity: check.severity,
              summary: check.summary,
              details: check.details,
              fix: check.remediation ?? undefined,
            })),
          },
        ],
        metadata: report.metadata,
      }),
    ).toContain(READINESS_DIAGNOSTIC_REMEDIATION['conflicting-args']);
  });
});

describe('custom runner consent preflight', () => {
  function shellPlannerConfigYaml(): string {
    return [
      'version: 3',
      'planner:',
      '  kind: shell',
      '  command: /bin/echo',
      '  model: planner-default',
      'implementer:',
      '  kind: api',
      '  provider: ollama',
      '  apiBase: http://localhost:11434/v1',
      '  model: qwen2.5-coder:7b',
      '  contextLength: 32768',
      'workflow:',
      '  mode: quick',
    ].join('\n');
  }

  async function withStdinTty(isTTY: boolean, run: () => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
    try {
      await run();
    } finally {
      if (original === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdin, 'isTTY', original);
    }
  }

  it('blocks on a shell runner this machine has not trusted, like a headless start', async () => {
    initGitRepo(tmp);
    writeConfig(tmp, shellPlannerConfigYaml());
    const writes = captureStdout();
    await expect(runDoctor(['--project', tmp, '--json'])).rejects.toThrow();

    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: DoctorJsonCheck[] };
    };
    const consent = parsed.report?.checks?.find((check) => check.id === 'runners.consent.planner');
    expect(consent).toMatchObject({ severity: 'blocker' });
  });

  it('exits non-zero on that config instead of reporting ready-with-warnings', async () => {
    initGitRepo(tmp);
    writeConfig(tmp, shellPlannerConfigYaml());
    captureStdout();
    let captured: unknown;
    try {
      await runDoctor(['--project', tmp, '--json']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode: number }).exitCode).toBe(1);
  });

  it('blocks on a shell reviewer this machine has not trusted', async () => {
    initGitRepo(tmp);
    writeConfig(
      tmp,
      [
        shellPlannerConfigYaml(),
        'reviewer:',
        '  kind: shell',
        '  command: /bin/echo',
        '  model: reviewer-default',
      ].join('\n'),
    );
    const writes = captureStdout();
    await expect(runDoctor(['--project', tmp, '--json'])).rejects.toThrow();

    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: DoctorJsonCheck[] };
    };
    const consent = parsed.report?.checks?.find((check) => check.id === 'runners.consent.reviewer');
    expect(consent).toMatchObject({ severity: 'blocker' });
  });

  it('reports no reviewer consent check when no reviewer is configured', async () => {
    initGitRepo(tmp);
    writeConfig(tmp, shellPlannerConfigYaml());
    const writes = captureStdout();
    await expect(runDoctor(['--project', tmp, '--json'])).rejects.toThrow();

    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: DoctorJsonCheck[] };
    };
    expect(
      parsed.report?.checks?.find((check) => check.id === 'runners.consent.reviewer'),
    ).toBeUndefined();
  });

  it('reports the same runner as a warning when a run would be able to prompt', async () => {
    initGitRepo(tmp);
    writeConfig(tmp, shellPlannerConfigYaml());
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });

    await withStdinTty(true, () => runDoctor(['--project', tmp]));

    expect(logged.join('\n')).toContain('Planner needs a one-time confirmation before it can run.');
  });
});
