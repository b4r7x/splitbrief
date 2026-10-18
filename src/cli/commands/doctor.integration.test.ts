import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import {
  cliAuthRemediation,
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
  type ReadinessReportJson,
} from '../../core/readiness/format.js';
import type { RunnerAvailabilityFact } from '../../core/readiness/checks/availability.js';
import type { ReadinessCheck } from '../../core/readiness/types.js';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import type { RunnerEvidence } from '../../core/discovery/runner-evidence.js';
import {
  detectRunnerEvidence,
  runnerDiscoveryContextKey,
} from '../../engine/detection/runner-evidence.js';
import { collectRunnerAdmissionChecks } from '../../engine/runners/prepare-execution/prepare-execution.js';
import { registerDoctorCommand, type SeatProbeCall } from './doctor.js';
import { saveDetectionCache } from '../../engine/detection/cache.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configStore } from '../../stores/project/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliReadinessFactsFor } from '#testing/helpers/factories/detection.js';

// Reading a tool's model list spawns the tool; a case that counts the reads answers them itself.
vi.mock('../../engine/detection/runner-evidence.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../engine/detection/runner-evidence.js')>();
  return { ...original, detectRunnerEvidence: vi.fn(original.detectRunnerEvidence) };
});

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
  overrides: Partial<Pick<RunnerEvidence, 'auth' | 'compatibility' | 'executable'>> = {},
): RunnerEvidence {
  const key = runnerDiscoveryContextKey(context);
  const testedVersion = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;
  return {
    runner: { id: 'codex', kind: 'cli', locality: 'local', enabled: 'enabled' },
    context: { key, observedAt: 1, source: 'fresh' },
    installation: 'installed',
    executable: overrides.executable ?? {
      kind: 'trusted',
      identity: codexExecutable.executableIdentity,
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
      selectionId: context.model ?? 'unselected',
      observedAt: 1,
      contextKey: key,
    },
  };
}

let tmp: string;
let shimDir: string;
let restoreCliShim: () => void;
let originalExitCode: typeof process.exitCode;
const hostPlatform = process.platform;

beforeEach(() => {
  originalExitCode = process.exitCode;
  tmp = createTempDir('doctor-command-test');
  shimDir = createTempDir('doctor-command-shim');
  // OpenCode and Kilo seats read their own config, so they read an empty one, never the tester's.
  vi.stubEnv('XDG_CONFIG_HOME', join(tmp, 'xdg-config'));
  restoreCliShim = activateCompatibleCliShim(
    installCompatibleCliShim({ directory: shimDir, tool: 'claude-code', authChannel: 'session' }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
  process.exitCode = originalExitCode;
  configStore.__testReset();
  restoreCliShim();
  cleanupTempDir(shimDir);
  cleanupTempDir(tmp);
  vi.restoreAllMocks();
  resetAllStores();
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
    '  testCommand: npm test',
    'workflow:',
    '  approve: plan',
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
  probeSeatCall?: SeatProbeCall,
): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerDoctorCommand(program, {
    detectCliReadiness,
    runArgVectorHelp,
    probeRunnerAvailability,
    collectRunnerAdmissionChecks: collectAdmissionChecks,
    ...(probeSeatCall !== undefined && { probeSeatCall }),
  });
  await program.parseAsync(['node', 'splitbrief', 'doctor', ...args]);
}

// A session sign-in denial is probed again after a delay for each seat; the
// fake clock spends that delay instead of the wall clock.
async function withFakeRetryClock(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let settled = false;
  const pending = run().finally(() => {
    settled = true;
  });
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersToNextTimerAsync();
  }
  await pending;
}

function captureStdout(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

function expectReadableDoctorProse(text: string, report: ReadinessReportJson): void {
  const prose = report.checks.flatMap((check) => [
    check.summary,
    ...(check.details ?? []),
    ...(check.remediation ? [check.remediation] : []),
  ]);
  for (const output of [text, ...prose, report.nextAction.label, report.nextAction.reason]) {
    for (const check of report.checks) expect(output).not.toContain(check.id);
    expect(output).not.toMatch(
      /Command options:|Configured args:|Arguments:|<PROMPT>|00000000-0000-4000-8000-000000000000|--permission-mode|\b(planner|implementer|reviewer)\b|PLAN.*(?:take over|edit files)|1 blockers|1 warnings|Fresh CLI evidence|authentication-unverified|isolated runner environment|credential bridge|keychain/i,
    );
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  expect(new Set(lines).size).toBe(lines.length);
  expect(new Set(prose).size).toBe(prose.length);
}

interface DoctorJsonCheck {
  id: string;
  severity: ReadinessCheck['severity'];
  summary: string;
  details?: string[];
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
  '  --disallowedTools <tools...>',
  '                             Tools to block in this session',
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
  it.each([{ args: [] }, { args: ['--json'] }])(
    'prints empty-folder blockers once with $args and exits 1',
    ({ args }) => {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'doctor', '--project', tmp, ...args],
        { encoding: 'utf8' },
      );

      expect(result.status, result.stderr).toBe(1);
      if (args.includes('--json')) {
        expect(result.stdout.match(/config\.missing/g)).toHaveLength(1);
        expect(result.stdout.match(/repo\.not-git/g)).toHaveLength(1);
      } else {
        expect(result.stdout).not.toMatch(/config\.missing|repo\.not-git/);
        expect(result.stdout.match(/No \.splitbrief\/config.yaml found\./g)).toHaveLength(1);
        expect(result.stdout.match(/Project is not a git repository\./g)).toHaveLength(1);
      }
      expect(result.stderr).toBe('');
    },
  );

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
    expect(output).toContain('info     End-of-run checks: on.');
    expect(readFileSync(configFile, 'utf-8')).toBe(beforeConfig);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'active'))).toBe(false);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
  });

  it('reports a Setup-written crew in text and JSON without repeated facts or internal names', async () => {
    initGitRepo(tmp);
    writeFileSync(join(tmp, 'package.json'), '{"scripts":{"test":"node --test"}}');
    configStore.load(tmp);
    const runner = { kind: 'cli', tool: 'claude-code', model: 'sonnet' } as const;
    const saved = await configStore.save(
      makeConfig({ planner: runner, reviewer: runner, implementer: runner }),
    );
    expect(saved.kind).toBe('saved');
    const configFile = join(tmp, SPLITBRIEF_DIR, CONFIG_FILE);
    const before = readFileSync(configFile, 'utf8');
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor(['--project', tmp]);
    const text = logged.mock.calls.map((call) => call.join(' ')).join('\n');
    const writes = captureStdout();
    await runDoctor(['--project', tmp, '--json']);
    const record = JSON.parse(writes.join('')) as { report: ReadinessReportJson };
    expectReadableDoctorProse(text, record.report);
    expect(text.match(/Plan approval: you approve the plan in the TUI\./g)).toHaveLength(1);
    expect(text.match(/Headless runs approve the plan automatically/g)).toHaveLength(1);
    expect(record.report.checks.filter((check) => check.id.endsWith('trust-boundary'))).toEqual([
      expect.objectContaining({ severity: 'info' }),
    ]);
    expect(record.report.counts).toMatchObject({ blocker: 0, warning: 1 });
    expect(text).toContain('(0 blockers, 1 warning)');
    expect(readFileSync(configFile, 'utf8')).toBe(before);
  });

  it('names the PLAN seat as REVIEW in text and JSON when no reviewer is configured', async () => {
    initGitRepo(tmp);
    configStore.load(tmp);
    const runner = { kind: 'cli', tool: 'claude-code', model: 'sonnet' } as const;
    expect(
      (await configStore.save(makeConfig({ planner: runner, implementer: runner }))).kind,
    ).toBe('saved');
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor(['--project', tmp]);
    const text = logged.mock.calls.map((call) => call.join(' ')).join('\n');
    const writes = captureStdout();
    await runDoctor(['--project', tmp, '--json']);
    const { report } = JSON.parse(writes.join('')) as { report: ReadinessReportJson };

    expectReadableDoctorProse(text, report);
    expect(text).toMatch(/^\s*ok\s+REVIEW = PLAN · Claude Code CLI · Sonnet 5\.5\.$/m);
    expect(report.checks.find((check) => check.id === 'runners.reviewer.inherited')).toEqual({
      id: 'runners.reviewer.inherited',
      severity: 'ok',
      summary: 'REVIEW = PLAN · Claude Code CLI · Sonnet 5.5.',
      stateId: null,
      remediation: null,
      details: [
        'REVIEW uses the tool and model of PLAN. To give REVIEW its own seat, choose one in Settings > Crew > REVIEW.',
      ],
      modelSelection: 'explicit',
    });
  });

  it.each([false, true])(
    'reports shared unknown authentication with another failing tool: %s',
    async (mixed) => {
      configStore.load(tmp);
      const codex = { kind: 'cli', tool: 'codex', model: 'gpt-5' } as const;
      const claude = { kind: 'cli', tool: 'claude-code', model: 'sonnet' } as const;
      expect(
        (
          await configStore.save(
            makeConfig({
              planner: mixed ? claude : codex,
              implementer: codex,
              reviewer: codex,
            }),
          )
        ).kind,
      ).toBe('saved');
      const detect = async () => [
        deriveCliReadiness({
          ...cliReadinessFactsFor('ready', 'codex'),
          authChannel: 'session',
          auth: 'unknown',
        }),
        ...(mixed
          ? [
              deriveCliReadiness({
                ...cliReadinessFactsFor('unavailable', 'claude-code'),
                authChannel: 'session',
              }),
            ]
          : []),
      ];
      const admission: typeof collectRunnerAdmissionChecks = async (input) =>
        collectRunnerAdmissionChecks({
          ...input,
          deps: {
            detectRunnerEvidence: async ({ context }) => ({
              ...freshCodexEvidence(context, { auth: 'unknown' }),
              runner: { id: context.id, kind: 'cli', locality: 'local', enabled: 'enabled' },
              ...(context.id === 'claude-code' ? { installation: 'missing' as const } : {}),
            }),
          },
        });
      const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runDoctor(['--project', tmp], detect, undefined, undefined, admission);
      const text = logged.mock.calls.map((call) => call.join(' ')).join('\n');
      const writes = captureStdout();
      await runDoctor(['--project', tmp, '--json'], detect, undefined, undefined, admission);
      const { report } = JSON.parse(writes.join('')) as { report: ReadinessReportJson };
      expectReadableDoctorProse(text, report);
      const auth = report.checks.filter((check) => check.stateId === 'auth-unknown');
      expect(auth).toHaveLength(1);
      expect(auth[0]?.severity).toBe('blocker');
      expect(auth[0]?.summary).toBe(
        `${mixed ? 'BUILD and REVIEW' : 'PLAN, BUILD and REVIEW'} cannot start with OpenAI Codex CLI.`,
      );
      expect(auth[0]?.details).toEqual(['OpenAI Codex CLI sign-in status is unknown.']);
      expect(auth[0]?.remediation).toContain('--allow-unverified-auth');
      expect(text.match(/OpenAI Codex CLI sign-in status is unknown\./g)).toHaveLength(1);
      expect(process.exitCode).toBe(1);
      if (mixed) {
        expect(report.checks.filter((check) => check.stateId === 'missing-binary')).toHaveLength(1);
        expect(text).toContain('PLAN cannot start with Claude Code CLI.');
      }
    },
  );

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

    await runDoctor(['--project', tmp], undefined, undefined, async () => [
      {
        slot: { role: 'implementer', profile: 'default' },
        provider: 'ollama',
        endpoint: 'http://localhost:11434/v1',
        verdict: { state: 'unavailable', diagnostic: 'fetch failed' },
      },
    ]);

    const output = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain(
      'blocker  BUILD Ollama · Qwen2.5 Coder 7B is not reachable at http://localhost:11434/v1.',
    );
    expect(output).toContain(
      'Fix: Run `ollama serve`, or choose another tool in Settings > Crew > BUILD, then run `splitbrief doctor` again.',
    );
    expect(process.exitCode).toBe(1);
  });

  it('runs no validation command', async () => {
    initGitRepo(tmp);
    writeConfig(
      tmp,
      validConfigYaml().replace('  testCommand: npm test', '  testCommand: touch doctor-ran'),
    );
    const writes = captureStdout();

    await runDoctor(['--project', tmp, '--json']);

    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: Array<{ id: string; details?: string[] }> };
    };
    const configured = parsed.report?.checks?.find((check) => check.id === 'validation.configured');
    expect(configured?.details).toContain('Test check command: touch doctor-ran');
    expect(existsSync(join(tmp, 'doctor-ran'))).toBe(false);
  });

  it('offers no --probe-validation in help', async () => {
    const program = new Command();
    program.exitOverride();
    registerDoctorCommand(program);
    const writes = captureStdout();

    await program.parseAsync(['node', 'splitbrief', 'doctor', '--help']).catch(() => undefined);

    expect(writes.join('')).not.toContain('--probe-validation');
  });

  it('reports automatic CLI model selection as auto, not as an unset model', async () => {
    initGitRepo(tmp);
    const checks = await doctorJsonChecks(
      validConfigYaml().replace('  tool: claude-code', '  tool: claude-code\n  model: auto'),
    );

    const planner = checks.find((check) => check.id === 'runners.planner.configured');
    expect(planner?.summary).toBe('PLAN Claude Code CLI · auto configured.');
    expect(planner?.modelSelection).toBe('auto');

    const implementer = checks.find((check) => check.id === 'runners.implementer.default');
    expect(implementer?.summary).toBe('BUILD Ollama · Qwen2.5 Coder 7B configured.');
  });

  it('names a seat by the catalog label the last discovery remembered', async () => {
    writeConfig(tmp);
    await saveDetectionCache({
      projectDir: tmp,
      snapshot: {
        contextKey: 'remembered',
        fetchedAt: 1,
        validatedAt: 1,
        generation: 1,
        requestId: 1,
        providers: [],
        cliTools: [],
        cliCatalogs: [
          { tool: 'codex', models: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }], probedAt: 1 },
        ],
      },
    });
    const checks = await doctorJsonChecks(
      validConfigYaml().replace(
        /implementer:\n( {2}.*\n)+/,
        'implementer:\n  kind: cli\n  tool: codex\n  model: gpt-6-luna\n',
      ),
    );

    const summaries = checks
      .filter((check) => check.id.startsWith('runners.implementer.'))
      .map((check) => check.summary);
    expect(summaries).toContain('BUILD OpenAI Codex CLI · GPT-6-Luna configured.');
    expect(summaries.join('\n')).not.toContain('GPT-6 Luna');
  });

  // A local-only OpenCode: no stored credential, a provider set up in its own config.
  it.each([
    { label: 'on auto', model: '\n  model: auto' },
    { label: 'with no model', model: '' },
  ])(
    'reports no sign-in blocker for a no-credential OpenCode seat $label whose own config selects a model its list serves',
    async ({ model }) => {
      initGitRepo(tmp);
      const configHome = join(tmp, 'config-home');
      mkdirSync(join(configHome, 'opencode'), { recursive: true });
      writeFileSync(
        join(configHome, 'opencode', 'opencode.json'),
        JSON.stringify({ model: 'ollama/llama3' }),
      );
      vi.stubEnv('XDG_CONFIG_HOME', configHome);
      try {
        writeConfig(
          tmp,
          validConfigYaml().replace(
            /implementer:\n( {2}.*\n)+/,
            `implementer:\n  kind: cli\n  tool: opencode${model}\n`,
          ),
        );
        await saveDetectionCache({
          projectDir: tmp,
          snapshot: {
            contextKey: 'remembered',
            fetchedAt: 1,
            validatedAt: 1,
            generation: 1,
            requestId: 1,
            providers: [],
            cliTools: [],
            cliCatalogs: [
              {
                tool: 'opencode',
                models: [{ id: 'ollama/llama3' }],
                namesProject: true,
                probedAt: 1,
              },
            ],
          },
        });
        const storesNoCredential = deriveCliReadiness({
          tool: 'opencode',
          enabled: true,
          installation: 'installed',
          executable: {
            path: '/usr/local/bin/opencode',
            fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
          },
          trust: 'trusted',
          installedVersion: CLI_TOOL_CATALOG.opencode.compatibility.testedVersion,
          testedVersion: CLI_TOOL_CATALOG.opencode.compatibility.testedVersion,
          compatibility: 'compatible',
          auth: 'unauthenticated',
          authChannel: 'provider-dependent',
          providerAuth: { kind: 'empty' },
          probedAt: 1,
        });
        const writes = captureStdout();
        await runDoctor(
          ['--project', tmp, '--json'],
          async () => [...deterministicCliReadiness(), storesNoCredential],
          async () => null,
          async () => [],
          async () => [],
        );
        const checks =
          (JSON.parse(writes.join('').trim()) as { report?: { checks?: DoctorJsonCheck[] } }).report
            ?.checks ?? [];

        expect(checks.find((check) => check.id === 'runners.cli.opencode.readiness')).toMatchObject(
          { severity: 'ok' },
        );
        expect(checks.filter((check) => check.severity === 'blocker')).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('reads the model list once for two OpenCode seats that store no credential, across both passes', async () => {
    initGitRepo(tmp);
    const configHome = join(tmp, 'config-home');
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    vi.mocked(detectRunnerEvidence).mockImplementation(async ({ context, includeCatalog }) => ({
      ...freshCodexEvidence(context, { auth: 'missing' }),
      runner: { id: 'opencode', kind: 'cli', locality: 'local', enabled: 'enabled' },
      providerAuth: { kind: 'empty' },
      ...(includeCatalog === true && {
        catalog: { kind: 'success', value: [{ id: 'ollama/llama3' }] },
      }),
    }));
    try {
      writeConfig(
        tmp,
        validConfigYaml()
          .replace(
            /planner:\n( {2}.*\n)+/,
            'planner:\n  kind: cli\n  tool: opencode\n  model: ollama/llama3\n',
          )
          .replace(
            /implementer:\n( {2}.*\n)+/,
            'implementer:\n  kind: cli\n  tool: opencode\n  model: ollama/llama3\n',
          ),
      );
      const storesNoCredential = deriveCliReadiness({
        tool: 'opencode',
        enabled: true,
        installation: 'installed',
        executable: {
          path: '/usr/local/bin/opencode',
          fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        },
        trust: 'trusted',
        installedVersion: CLI_TOOL_CATALOG.opencode.compatibility.testedVersion,
        testedVersion: CLI_TOOL_CATALOG.opencode.compatibility.testedVersion,
        compatibility: 'compatible',
        auth: 'unauthenticated',
        authChannel: 'provider-dependent',
        providerAuth: { kind: 'empty' },
        probedAt: 1,
      });
      const writes = captureStdout();
      await runDoctor(['--project', tmp, '--json'], async () => [storesNoCredential]);
      const checks =
        (JSON.parse(writes.join('').trim()) as { report?: { checks?: DoctorJsonCheck[] } }).report
          ?.checks ?? [];

      expect(
        vi
          .mocked(detectRunnerEvidence)
          .mock.calls.filter(([input]) => input.includeCatalog === true),
      ).toHaveLength(1);
      expect(checks.filter((check) => check.severity === 'blocker')).toEqual([]);
    } finally {
      vi.mocked(detectRunnerEvidence).mockReset();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      label: 'an explicit model',
      model: '\n  model: opus',
      expected: 'explicit',
      identity: 'Opus 5.5',
    },
    { label: 'no model key', model: '', expected: 'unset', identity: 'auto' },
  ])(
    'publishes $label as a JSON model selection distinct from auto',
    async ({ model, expected, identity }) => {
      initGitRepo(tmp);
      const checks = await doctorJsonChecks(
        validConfigYaml().replace('  tool: claude-code', `  tool: claude-code${model}`),
      );

      const planner = checks.find((check) => check.id === 'runners.planner.configured');
      expect(planner?.modelSelection).toBe(expected);
      expect(planner?.summary).toBe(`PLAN Claude Code CLI · ${identity} configured.`);
    },
  );

  it('doctor readiness for a config denied headless admission contains a `runners.preparation.` check whose remediation names `--allow-unverified-auth`', async () => {
    initGitRepo(tmp);
    writeConfig(
      tmp,
      validConfigYaml().replace('  tool: claude-code', '  tool: codex\n  authChannel: session'),
    );
    const writes = captureStdout();

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

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: Array<{ id: string; remediation?: string | null }> };
    };
    const preparationCheck = parsed.report?.checks?.find((check) =>
      check.id.startsWith('runners.preparation.'),
    );
    expect(preparationCheck).toBeDefined();
    expect(preparationCheck?.remediation).toContain('--allow-unverified-auth');
  });

  it.each([
    {
      label: 'incompatible version',
      status: 'incompatible',
      evidence: {
        compatibility: {
          kind: 'incompatible',
          installedVersion: '0.1.0',
          testedVersion: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
        },
      },
      stateId: 'incompatible-version',
      message: 'OpenAI Codex CLI version is not compatible.',
    },
    {
      label: 'unknown version',
      status: 'ready',
      facts: { installedVersion: null, compatibility: 'unverified' },
      evidence: {
        compatibility: {
          kind: 'unknown',
          installedVersion: null,
          testedVersion: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
        },
      },
      message: 'OpenAI Codex CLI version could not be confirmed as compatible.',
    },
    {
      label: 'untrusted executable',
      status: 'untrusted',
      evidence: { executable: { kind: 'untrusted' } },
      stateId: 'untrusted-path',
      message: 'OpenAI Codex CLI executable could not be trusted.',
    },
    {
      label: 'missing executable',
      status: 'unavailable',
      evidence: { executable: { kind: 'missing' } },
      stateId: 'missing-binary',
      message: 'OpenAI Codex CLI is not installed.',
    },
    {
      label: 'signed-out session',
      status: 'unauthenticated',
      evidence: { auth: 'missing' },
      stateId: 'unauthenticated',
      message: 'OpenAI Codex CLI is not signed in.',
    },
    {
      label: 'authentication timeout',
      status: 'ready',
      evidence: { auth: 'timeout' },
      stateId: 'auth-timeout',
      message: 'OpenAI Codex CLI sign-in check timed out.',
      remedy: 'Check the network connection, then run `splitbrief doctor` again.',
    },
    {
      label: 'offline authentication probe',
      status: 'ready',
      evidence: { auth: 'offline' },
      stateId: 'auth-offline',
      message: 'OpenAI Codex CLI sign-in check could not connect.',
      remedy: 'Check the network connection, then run `splitbrief doctor` again.',
    },
    {
      label: 'unreadable authentication probe',
      status: 'ready',
      evidence: { auth: 'malformed' },
      stateId: 'auth-malformed',
      message: 'SPLITBRIEF could not read the OpenAI Codex CLI sign-in check result.',
      remedy: 'Run `splitbrief doctor` again. If the result is still unreadable, update the CLI.',
    },
  ] as const)('preserves the cause and remedy for $label in text and JSON', async (scenario) => {
    initGitRepo(tmp);
    configStore.load(tmp);
    const seat = { kind: 'cli', tool: 'codex', authChannel: 'session' } as const;
    expect(
      (await configStore.save(makeConfig({ planner: seat, reviewer: seat, implementer: seat }))).ok,
    ).toBe(true);
    // Detection records the authentication selection only for a resolved
    // executable, so a missing or untrusted CLI result carries none.
    const readiness = deriveCliReadiness({
      ...cliReadinessFactsFor(scenario.status, 'codex'),
      ...('facts' in scenario && scenario.facts),
      ...(scenario.status !== 'untrusted' &&
        scenario.status !== 'unavailable' && { authChannel: 'session' }),
    });
    const remedy = 'remedy' in scenario ? scenario.remedy : readiness.remediation;
    const admissionChecks: typeof collectRunnerAdmissionChecks = (input) =>
      collectRunnerAdmissionChecks({
        ...input,
        deps: {
          detectRunnerEvidence: async ({ context }) =>
            freshCodexEvidence(context, scenario.evidence),
        },
      });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await withFakeRetryClock(() =>
      runDoctor(['--project', tmp], async () => [readiness], undefined, undefined, admissionChecks),
    );
    const text = logged.mock.calls.map((call) => call.join(' ')).join('\n');
    const writes = captureStdout();
    await withFakeRetryClock(() =>
      runDoctor(
        ['--project', tmp, '--json'],
        async () => [readiness],
        undefined,
        undefined,
        admissionChecks,
      ),
    );
    const { report } = JSON.parse(writes.join('')) as { report: ReadinessReportJson };
    const checks = report.checks.filter((check) => check.id.startsWith('runners.preparation.'));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      summary: 'PLAN, BUILD and REVIEW cannot start with OpenAI Codex CLI.',
      seats: ['PLAN', 'BUILD', 'REVIEW'],
      details: [scenario.message],
      ...('stateId' in scenario && { stateId: scenario.stateId }),
      remediation: remedy,
    });
    expect(report.checks.filter((check) => check.remediation === remedy)).toHaveLength(1);
    expect(text).toContain(scenario.message);
    expect(text).toContain(`Fix: ${remedy}`);
    expect(text).not.toContain('Review the configured runner');
    expect(text.split(`${remedy}`)).toHaveLength(2);
    expectReadableDoctorProse(text, report);
    if ('stateId' in scenario && scenario.stateId.startsWith('auth-')) {
      expect(text).not.toContain('is not signed in');
      expect(text).not.toContain('Sign in to');
      expect(JSON.stringify(report)).not.toContain('unauthenticated');
    }
    expect(process.exitCode).toBe(1);
  });

  it('gives the Linux platform remedy for Antigravity session authentication in text and JSON', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    writeConfig(tmp, validConfigYaml().replace('  tool: claude-code', '  tool: antigravity'));
    const readiness = deriveCliReadiness({
      ...cliReadinessFactsFor('unverified', 'antigravity'),
      authChannel: 'session',
    });
    const admissionChecks: typeof collectRunnerAdmissionChecks = (input) =>
      collectRunnerAdmissionChecks({
        ...input,
        deps: {
          detectRunnerEvidence: async ({ context }) => ({
            ...freshCodexEvidence(context, { auth: 'policy-denied' }),
            runner: { id: 'antigravity', kind: 'cli', locality: 'local', enabled: 'enabled' },
          }),
        },
      });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await withFakeRetryClock(() =>
      runDoctor(['--project', tmp], async () => [readiness], undefined, undefined, admissionChecks),
    );
    const text = logged.mock.calls.map((call) => call.join(' ')).join('\n');
    const writes = captureStdout();
    await withFakeRetryClock(() =>
      runDoctor(
        ['--project', tmp, '--json'],
        async () => [readiness],
        undefined,
        undefined,
        admissionChecks,
      ),
    );
    const { report } = JSON.parse(writes.join('')) as { report: ReadinessReportJson };
    const checks = report.checks.filter((check) => check.stateId === 'auth-policy-denied');
    const remedy = cliAuthRemediation({ tool: 'antigravity', authChannel: 'session' }, 'doctor');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ severity: 'blocker', remediation: remedy });
    expect(text).toContain(`Fix: ${remedy}`);
    expect(text).not.toContain(READINESS_DIAGNOSTIC_REMEDIATION['auth-policy-denied']);
    expect(JSON.stringify(report)).not.toContain(
      READINESS_DIAGNOSTIC_REMEDIATION['auth-policy-denied'],
    );
    expect(text.split(remedy)).toHaveLength(2);
    expectReadableDoctorProse(text, report);
    expect(process.exitCode).toBe(1);
  });

  it('keeps distinct sign-in causes from readiness and admission', async () => {
    initGitRepo(tmp);
    configStore.load(tmp);
    const seat = { kind: 'cli', tool: 'codex' } as const;
    expect(
      (await configStore.save(makeConfig({ planner: seat, reviewer: seat, implementer: seat }))).ok,
    ).toBe(true);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor(
      ['--project', tmp],
      async () => [deriveCliReadiness(cliReadinessFactsFor('unauthenticated', 'codex'))],
      undefined,
      undefined,
      async (input) =>
        collectRunnerAdmissionChecks({
          ...input,
          deps: {
            detectRunnerEvidence: async ({ context }) =>
              freshCodexEvidence(context, { auth: 'unknown' }),
          },
        }),
    );
    const text = logged.mock.calls.map((call) => call.join(' ')).join('\n');
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(new Set(lines).size).toBe(lines.length);
    expect(text).toContain('(2 blockers, 1 warning)');
    expect(text).toContain('OpenAI Codex CLI is not signed in.');
    expect(text).toContain('PLAN, BUILD and REVIEW cannot start with OpenAI Codex CLI.');
    expect(text).toContain('OpenAI Codex CLI sign-in status is unknown.');
    expect(process.exitCode).toBe(1);
  });

  it('emits JSON and exits non-zero for missing config without writing setup files', async () => {
    initGitRepo(tmp);
    const writes = captureStdout();

    await runDoctor(['--project', tmp, '--json']);

    expect(process.exitCode).toBe(1);
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

    await runDoctor(['--project', tmp, '--json']);

    expect(process.exitCode).toBe(1);
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

    await runDoctor(['--project', tmp, '--json']);

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: Array<{ id: string; details?: string[] }> };
    };
    const invalid = parsed.report?.checks?.find((check) => check.id === 'config.invalid');
    expect(invalid?.details).toContainEqual(
      expect.stringContaining('workflow.autoApproveSpec: Unknown config key'),
    );
  });

  it('renders each blocker on its own line in the readiness report', async () => {
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
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDoctor(['--project', tmp]);

    expect(process.exitCode).toBe(1);
    const rendered = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const lines = rendered.split('\n').filter((line) => line.trimStart().startsWith('blocker '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Config could not be loaded.');
    expect(lines[1]).toContain('Project is not a git repository.');
  });

  it('reports a non-git project as blocked', async () => {
    writeConfig(tmp);
    const writes = captureStdout();

    await runDoctor(['--project', tmp, '--json']);

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: Array<{ id: string }> };
    };
    expect(parsed.report?.checks?.map((check) => check.id)).toContain('repo.not-git');
  });

  it('reports a zero-commit repository as blocked', async () => {
    initGitRepoWithoutCommit(tmp);
    writeConfig(tmp);
    const writes = captureStdout();

    await runDoctor(['--project', tmp, '--json']);

    expect(process.exitCode).toBe(1);
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

    await runDoctor(['--project', tmp, '--json']);

    expect(process.exitCode).toBe(1);
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

      await runDoctor(['--project', tmp, '--json'], async () => [cliResult]);

      if (stateId !== 'auth-unknown') {
        expect(process.exitCode).toBe(1);
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
      await runDoctor(['--project', tmp], async () => [cliResult]);
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
    expect(human).toContain('Run readiness: ready with warnings');
    expect(human).not.toContain('start can continue');
    expect(human).toContain('No trusted readiness identity for claude-code');
    expect(human).toContain('--allow-unverified-auth');
    const remediation = unverified.remediation;
    expect(remediation).toBeTruthy();
    expect(human).toContain(remediation);
  });

  it('blocks on an emitted flag the installed binary does not advertise', async () => {
    initGitRepo(tmp);
    writeConfig(tmp);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDoctor(
      ['--project', tmp],
      undefined,
      async () => CLAUDE_HELP_WITHOUT_PARTIAL_MESSAGES,
    );

    const human = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const argVectorLine = human
      .split('\n')
      .find((line) => line.includes('does not support options PLAN uses'));
    expect(argVectorLine).toContain('blocker');
    expect(argVectorLine).toContain(
      'does not support options PLAN uses: --include-partial-messages.',
    );
    expect(process.exitCode).toBe(1);
  });

  it('checks the opencode vector for the release readiness detected, as dispatch builds it', async () => {
    initGitRepo(tmp);
    writeConfig(
      tmp,
      validConfigYaml()
        .replace('  tool: claude-code', '  tool: opencode')
        .replace(
          /implementer:\n(?: {2}.*\n)+/,
          'implementer:\n  kind: cli\n  tool: opencode\n  model: opencode-go/deepseek-v4-flash\n  variant: high\n',
        ),
    );
    const opencodeReadiness = deriveCliReadiness({
      tool: 'opencode',
      enabled: true,
      installation: 'installed',
      executable: {
        path: '/usr/local/bin/opencode',
        fingerprint: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
      },
      trust: 'trusted',
      installedVersion: '2.0.14',
      testedVersion: CLI_TOOL_CATALOG.opencode.compatibility.testedVersion,
      compatibility: 'compatible',
      auth: 'authenticated',
      probedAt: 1,
    });
    const v2RunHelp = readFileSync(
      join(import.meta.dirname, '../../../testing/fixtures/cli-help/opencode-v2-run-help.txt'),
      'utf8',
    );
    const writes = captureStdout();

    await runDoctor(
      ['--project', tmp, '--json'],
      async () => [opencodeReadiness],
      async () => v2RunHelp,
      undefined,
      async () => [],
    ).catch(() => undefined);

    const checks =
      (JSON.parse(writes.join('').trim()) as { report?: { checks?: ReadinessCheck[] } }).report
        ?.checks ?? [];
    const argVector = checks.find(
      (check) => check.id === 'runners.cli.opencode.arg-vector.implementer',
    );
    expect(argVector?.severity).toBe('ok');
    expect(argVector?.details).toBeUndefined();
    expect(argVector?.summary).toBe('OpenCode CLI supports the options BUILD uses.');
  });

  it('reports no arg-vector blocker when the installed binary yields no help text', async () => {
    initGitRepo(tmp);

    const checks = await doctorJsonChecks(validConfigYaml());

    const argVector = checks.find(
      (check) => check.id === 'runners.cli.claude-code.arg-vector.planner',
    );
    expect(argVector?.severity).toBe('ok');
    expect(argVector?.summary).toContain('options for PLAN are configured.');
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
      '  approve: plan',
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
    await runDoctor(['--project', tmp, '--json']);
    expect(process.exitCode).toBe(1);

    const parsed = JSON.parse(writes.join('').trim()) as {
      report?: { checks?: DoctorJsonCheck[] };
    };
    const consent = parsed.report?.checks?.find((check) => check.id === 'runners.consent.planner');
    expect(consent).toMatchObject({ severity: 'blocker' });
    const refusals = parsed.report?.checks?.filter((check) =>
      check.details?.some((detail) => detail.includes('this machine has not trusted')),
    );
    expect(refusals).toHaveLength(1);
  });

  it('exits non-zero on that config instead of reporting ready-with-warnings', async () => {
    initGitRepo(tmp);
    writeConfig(tmp, shellPlannerConfigYaml());
    captureStdout();
    await runDoctor(['--project', tmp, '--json']);

    expect(process.exitCode).toBe(1);
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
    await runDoctor(['--project', tmp, '--json']);
    expect(process.exitCode).toBe(1);

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
    await runDoctor(['--project', tmp, '--json']);
    expect(process.exitCode).toBe(1);

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

    expect(logged.join('\n')).toContain('PLAN needs a one-time confirmation before it can run.');
  });
});

describe('doctor --probe-seat', () => {
  function captureLogged(): string[] {
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(' '));
    });
    return logged;
  }

  it('records one paid call and prints its class and first error line', async () => {
    initGitRepo(tmp);
    writeConfig(tmp);
    const logged = captureLogged();
    const calls: Array<{ projectDir: string; seat: string }> = [];
    const probeSeatCall: SeatProbeCall = async (input) => {
      calls.push({ projectDir: input.projectDir, seat: input.seat });
      return {
        seat: input.seat,
        tool: 'claude-code',
        stdout: '',
        stderr: 'Insufficient balance: the account has no credits.\n',
        exitStatus: 1,
        signal: null,
        timedOut: false,
        outputExceeded: false,
      };
    };

    await runDoctor(
      ['--project', tmp, '--probe-seat', 'plan'],
      undefined,
      undefined,
      undefined,
      undefined,
      probeSeatCall,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.seat).toBe('plan');
    const output = logged.join('\n');
    expect(output).toContain('Seat probe PLAN: account');
    expect(output).toContain('Insufficient balance: the account has no credits.');

    const probesDir = join(tmp, SPLITBRIEF_DIR, 'probes');
    const files = readdirSync(probesDir);
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(probesDir, files[0] ?? ''), 'utf8')) as {
      class: string;
      tool: string;
      seat: string;
      exitStatus: number;
      stderr: string;
    };
    expect(record).toMatchObject({
      class: 'account',
      tool: 'claude-code',
      seat: 'plan',
      exitStatus: 1,
    });
    expect(record.stderr).toContain('Insufficient balance');
  });

  it('passes a call whose stream ends in a completed result', async () => {
    initGitRepo(tmp);
    writeConfig(tmp);
    const logged = captureLogged();
    const stdout = readFileSync(
      join(import.meta.dirname, '../../../testing/fixtures/antigravity/stream-json-1.3.1.ndjson'),
      'utf8',
    );
    const probeSeatCall: SeatProbeCall = async (input) => ({
      seat: input.seat,
      tool: 'antigravity',
      stdout,
      stderr: '',
      exitStatus: 0,
      signal: null,
      timedOut: false,
      outputExceeded: false,
    });

    await runDoctor(
      ['--project', tmp, '--probe-seat', 'build'],
      undefined,
      undefined,
      undefined,
      undefined,
      probeSeatCall,
    );

    expect(logged).toEqual(['Seat probe BUILD: passed']);
    const probesDir = join(tmp, SPLITBRIEF_DIR, 'probes');
    const record = JSON.parse(
      readFileSync(join(probesDir, readdirSync(probesDir)[0] ?? ''), 'utf8'),
    ) as { class: string };
    expect(record.class).toBe('passed');
  });

  it('classifies a failed result by its own error, not by the stream frames', async () => {
    initGitRepo(tmp);
    writeConfig(tmp);
    const logged = captureLogged();
    const stdout = [
      JSON.stringify({
        event: 'init',
        conversation_id: 'c1',
        init: { tools: ['browser_get_network_request'] },
      }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'c1', status: 'ERROR', error: 'Model refused the request' },
      }),
    ].join('\n');
    const probeSeatCall: SeatProbeCall = async (input) => ({
      seat: input.seat,
      tool: 'antigravity',
      stdout,
      stderr: '',
      exitStatus: 0,
      signal: null,
      timedOut: false,
      outputExceeded: false,
    });

    await runDoctor(
      ['--project', tmp, '--probe-seat', 'build'],
      undefined,
      undefined,
      undefined,
      undefined,
      probeSeatCall,
    );

    expect(logged).toEqual(['Seat probe BUILD: other', 'First error: Model refused the request']);
  });

  it('makes no seat call without the flag', async () => {
    initGitRepo(tmp);
    writeConfig(tmp);
    captureLogged();
    let probeCalls = 0;
    const probeSeatCall: SeatProbeCall = async () => {
      probeCalls += 1;
      throw new Error('a seat probe must not run without --probe-seat');
    };

    await runDoctor(['--project', tmp], undefined, undefined, undefined, undefined, probeSeatCall);

    expect(probeCalls).toBe(0);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'probes'))).toBe(false);
  });

  it('describes the paid call it makes in its help text', async () => {
    const program = new Command();
    program.exitOverride();
    registerDoctorCommand(program);
    const writes = captureStdout();

    await program.parseAsync(['node', 'splitbrief', 'doctor', '--help']).catch(() => undefined);

    const help = writes.join('');
    expect(help).toContain('--probe-seat');
    expect(help).toContain('one paid call through one seat: plan, build, review');
  });

  it('rejects a seat outside plan, build and review', async () => {
    await expect(runDoctor(['--project', tmp, '--probe-seat', 'deploy'])).rejects.toThrow(
      'plan, build, review',
    );
  });
});
