import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_CLI_ADMISSION_VERDICT,
  CLI_TOOL_CATALOG,
  CURSOR_CLI_ADMISSION_VERDICT,
  IMPLEMENTER_CLI_TOOL_IDS,
} from '../../../src/core/runners/cli-tool-catalog.js';
import type { CliImplementerConfig } from '../../../src/core/schemas/implementer-config.js';
import type { ImplementerCliToolId } from '../../../src/core/schemas/enums.js';
import { RUNNER_OUTCOME_STATES } from '../../../src/engine/runners/errors.js';
import { createCliImplementer } from '../../../src/engine/implementers/cli.js';
import { runnerCallOutcome } from '../../../src/engine/implementers/pipeline/call-result.js';
import type { RunnerCallResult, RunnerCallStatus } from '../../../src/engine/calls/types.js';
import {
  CLI_IMPLEMENTER_ADAPTERS,
  lookupCliPlannerAdapter,
} from '../../../src/engine/runners/cli-tools/registry.js';
import { probeCliReadiness } from '../../../src/engine/runners/cli-tools/readiness-probe.js';
import { invokeCliAdapter } from '../../../src/engine/runners/invoke-cli-adapter.js';
import { CLI_PROMPT_SENTINEL } from '../../../src/engine/runners/cli-tools/candidate-contract.js';
import { resolveCliExecutable } from '../../../src/engine/runners/resolve-cli-executable.js';
import type { CliStartGate } from '../../../src/engine/runners/start-gate.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo, startConflictingMerge } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  prependPath,
  writeConflictProbeShim,
  writeContractShim,
  type ContractShimMode,
  type ContractShimProfile,
} from '#testing/helpers/command-shim.js';

const ADMITTED_IMPLEMENTER_IDS = [...IMPLEMENTER_CLI_TOOL_IDS] as const;

const PROMPT_HEAD = 'HEAD_SENTINEL ';
const PROMPT_TAIL = ' TAIL_SENTINEL';
const FULL_PROMPT = `${PROMPT_HEAD}implement src/contract.ts${PROMPT_TAIL}`;
const LARGE_ARGV_PROMPT = `${PROMPT_HEAD}${'x'.repeat(100_000)}${PROMPT_TAIL}`;

function canonicalVersionLine(toolId: ImplementerCliToolId, version: string): string {
  switch (toolId) {
    case 'claude-code':
      return `${version} (Claude Code)`;
    case 'codex':
      return `codex-cli ${version}`;
    case 'opencode':
      return `opencode v${version}`;
    case 'kilo-code':
    case 'cursor':
    case 'command-code':
    case 'antigravity':
      return version;
    case 'copilot':
      return `GitHub Copilot CLI ${version}.`;
  }
}

const SHIM_PROFILES: Record<ImplementerCliToolId, ContractShimProfile> = {
  'claude-code': {
    transport: 'stdin',
    versionLine: canonicalVersionLine('claude-code', '2.0.0'),
    successLines: ['{"type":"result","result":"done"}'],
    authArgv: ['auth'],
  },
  codex: {
    transport: 'stdin',
    versionLine: canonicalVersionLine('codex', '0.40.0'),
    successLines: ['{"type":"turn.completed"}'],
    authArgv: ['auth'],
  },
  opencode: {
    transport: 'argv',
    versionLine: canonicalVersionLine('opencode', '2.0.14'),
    successLines: ['{"type":"text","part":{"type":"text","text":"ok"}}'],
    authArgv: ['auth'],
  },
  copilot: {
    transport: 'argv',
    versionLine: canonicalVersionLine('copilot', '1.0.77'),
    successLines: ['ok'],
    authArgv: ['auth', 'status'],
  },
  'kilo-code': {
    transport: 'argv',
    versionLine: canonicalVersionLine('kilo-code', '0.1.0'),
    successLines: ['ok'],
    authArgv: ['auth'],
  },
  cursor: {
    transport: 'argv',
    versionLine: canonicalVersionLine('cursor', '2026.08.25-3e8eec8'),
    successLines: [
      '{"type":"system","subtype":"init","session_id":"contract-session"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"done"}',
    ],
    authArgv: ['status'],
  },
  'command-code': {
    transport: 'argv',
    versionLine: canonicalVersionLine('command-code', '1.39.2'),
    successLines: [
      '{"type":"event","event":{"type":"tool_running","toolCallId":"call_1","toolName":"read_file"}}',
      '{"type":"result","subtype":"success","sessionId":"contract-session","stopReason":"end_turn","finalText":"done","usage":{"inputTokens":10,"outputTokens":2}}',
    ],
    authArgv: ['status', '--json'],
  },
  antigravity: {
    transport: 'argv',
    versionLine: canonicalVersionLine('antigravity', '1.4.7'),
    successLines: [
      '{"event":"init","conversation_id":"50328626-c5df-4301-9da7-dee7ce900271","init":{"cwd":"/tmp/probe","tools":["ask_custom_permission","ask_permission","ask_question","browser_click_element","browser_drag_pixel_to_pixel","browser_get_dom","browser_get_network_request","browser_input","browser_list_network_requests","browser_mouse_down","browser_mouse_up","browser_move_mouse","browser_press_key","browser_refresh_page","browser_resize_window","browser_scroll","browser_scroll_dom","browser_select_option","browser_subagent","call_mcp_tool","capture_browser_console_logs","capture_browser_screenshot","click_browser_pixel","command_status","define_subagent","delete_knowledge","execute_browser_javascript","find_by_name","finish","generate_image","grep_search","invoke_subagent","list_browser_pages","list_dir","list_permissions","list_resources","manage_inbox","manage_subagents","manage_task","multi_replace_file_content","notebook_edit","notebook_execution","open_browser_url","read_browser_page","read_resource","read_url_content","replace_file_content","run_command","schedule","search_web","sed_file","send_command_input","send_message","view_file","wait","wait_5_seconds","write_to_file"],"permission_mode":"always-proceed"}}',
      '{"event":"result","result":{"conversation_id":"50328626-c5df-4301-9da7-dee7ce900271","status":"SUCCESS","response":"OK\\n","duration_seconds":9.536092,"num_turns":1,"usage":{"input_tokens":59864,"output_tokens":1271,"thinking_tokens":999,"cache_read_tokens":0,"total_tokens":61135}}}',
    ],
    authArgv: ['models'],
  },
};

const AUTH_CHANNELS: Record<ImplementerCliToolId, CliImplementerConfig['authChannel']> = {
  'claude-code': 'session',
  codex: 'session',
  opencode: 'provider-dependent',
  copilot: 'session',
  'kilo-code': 'provider-dependent',
  cursor: 'session',
  'command-code': 'session',
  antigravity: 'session',
};

// With session state seeded, every probe-bearing adapter runs its declared
// status command; the shim's exit-1 failure maps to the adapter-declared
// 'unknown', never to an authenticated fallback. Copilot declares no
// auth-status probe, so bridged session-state presence resolves its fact.
// Opencode and kilo-code declare the provider credential oracle
// (`providers list` / `auth list`); these shims cannot print oracle-format
// output, which is a parse failure, so their fact falls back to bridged
// session-state presence. Command Code declares `status --json`, so like
// claude-code, codex and cursor its exit-1 shim resolves to 'unknown'.
// The clean oracle paths and the absent-state
// 'missing' path are pinned by readiness-probe-session-presence.test.ts.
const AUTH_FAILURE_FACTS_BY_PROBE_CONTRACT = {
  'claude-code': 'unknown',
  codex: 'unknown',
  opencode: 'authenticated',
  // A bridged config file signs Copilot in on Linux; on macOS its token is a keychain item.
  copilot: process.platform === 'darwin' ? 'unknown' : 'authenticated',
  'kilo-code': 'authenticated',
  cursor: 'unknown',
  'command-code': 'unknown',
  // The session channel is allowed only on macOS; other platforms deny the probe.
  antigravity: process.platform === 'darwin' ? 'unauthenticated' : 'unknown',
} as const satisfies Record<
  ImplementerCliToolId,
  'authenticated' | 'not-checked' | 'unknown' | 'unauthenticated'
>;

const HOME_SESSION_STATE_PATHS: Partial<Record<ImplementerCliToolId, string>> = {
  'claude-code': '.claude/.credentials.json',
  codex: '.codex/auth.json',
  opencode: '.config/opencode/auth.json',
  copilot: '.copilot/config.json',
  'kilo-code': '.config/kilo/auth.json',
  cursor: '.config/cursor/auth.json',
  'command-code': '.commandcode/auth.json',
};

const STATE_SOURCE_ENV = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

/**
 * Runs the auth-failure probe against a seeded session-state home so the
 * declared probe executes on every machine, independent of the developer's
 * real logins or keychain.
 */
async function withSeededSessionStateHome<T>(
  toolId: ImplementerCliToolId,
  run: () => Promise<T>,
): Promise<T> {
  const stateHome = createTempDir('contract-auth-state-home');
  const relativePath = HOME_SESSION_STATE_PATHS[toolId];
  if (relativePath !== undefined) {
    mkdirSync(join(stateHome, dirname(relativePath)), { recursive: true });
    writeFileSync(join(stateHome, relativePath), '{"session":"stub"}\n', 'utf8');
  }
  const saved = STATE_SOURCE_ENV.map((name) => [name, process.env[name]] as const);
  process.env['HOME'] = stateHome;
  for (const name of STATE_SOURCE_ENV) {
    if (name !== 'HOME') delete process.env[name];
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    cleanupTempDir(stateHome);
  }
}

const CONFLICTING_ARGS: Record<ImplementerCliToolId, readonly string[]> = {
  'claude-code': ['--output-format', 'text'],
  codex: ['--json'],
  opencode: ['--format', 'json'],
  copilot: ['--output-format', 'text'],
  'kilo-code': ['--output-format', 'text'],
  cursor: ['--force'],
  'command-code': ['--permission-mode', 'plan'],
  antigravity: ['--output-format', 'text'],
};

/**
 * The flag each admitted implementer tool takes its workspace from, checked
 * against the tool's own `--help` on 2026-09-23. Every tool is spawned in the
 * seat directory; a tool whose headless mode keeps its workspace apart from its
 * cwd also gets that directory on this flag. Without `--add-dir`, agy 1.2.9 ran
 * its shell in `~/.gemini/antigravity-cli/scratch`. `null`: the cwd is the
 * workspace, and the tool's own directory flags only add roots
 * (`claude --add-dir`, `cmd --add-dir`, `copilot --add-dir`) or change a cwd the
 * tool already has (`copilot -C`, `kilo run --dir`); `opencode run` 2.x has none.
 * `scripts/cli-conformance.ts cwd` measures the live behaviour.
 */
const WORKSPACE_FLAGS: Record<ImplementerCliToolId, string | null> = {
  'claude-code': null,
  codex: '--cd',
  opencode: null,
  copilot: null,
  'kilo-code': null,
  cursor: '--workspace',
  'command-code': null,
  antigravity: '--add-dir',
};

const FLAGGED_WORKSPACE_IDS = ADMITTED_IMPLEMENTER_IDS.filter(
  (toolId) => WORKSPACE_FLAGS[toolId] !== null,
);

const CREDENTIAL_ENV: Partial<Record<ImplementerCliToolId, Readonly<Record<string, string>>>> = {
  'claude-code': { ANTHROPIC_API_KEY: 'sk-ant-contract-canary' },
  codex: { OPENAI_API_KEY: 'sk-openai-contract-canary' },
  copilot: { GITHUB_TOKEN: 'ghp-contract-canary' },
};

type Fixture = {
  toolId: ImplementerCliToolId;
  projectDir: string;
  shimDir: string;
  captureDir: string;
  restorePath: () => void;
  trustedGate: CliStartGate;
};

const fixtures: Fixture[] = [];
let originalPath: string | undefined;

function shimEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return { PATH: process.env.PATH ?? '', ...extra };
}

function isStructuredTerminal(toolId: ImplementerCliToolId): boolean {
  return CLI_IMPLEMENTER_ADAPTERS[toolId].outputContract.kind === 'structured-terminal';
}

function trustedGateFor(toolId: ImplementerCliToolId, shimDir: string): CliStartGate {
  const command = CLI_TOOL_CATALOG[toolId].command;
  const commandPath = join(shimDir, command);
  const path = realpathSync(commandPath);
  const info = statSync(path);
  return {
    tool: toolId,
    executable: {
      path,
      fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
    },
  };
}

function implementerConfig(
  toolId: ImplementerCliToolId,
  overrides: Partial<CliImplementerConfig> = {},
) {
  return {
    kind: 'cli' as const,
    tool: toolId,
    contextLength: 8192,
    temperature: 0.2,
    ...overrides,
  };
}

function resetCapture(fixture: Fixture): void {
  for (const name of ['argv.lines', 'stdin.txt', 'started.marker', 'descendant.pid']) {
    const capturePath = join(fixture.captureDir, name);
    if (existsSync(capturePath)) rmSync(capturePath);
  }
}

function refreshTrustedGate(fixture: Fixture): void {
  fixture.trustedGate = trustedGateFor(fixture.toolId, fixture.shimDir);
}

function installShim(
  fixture: Fixture,
  mode: ContractShimMode,
  opts: {
    targetRelPath?: string;
    outsidePath?: string;
    exitCode?: number;
    versionLine?: string;
    versionExitCode?: number;
    authExitCode?: number;
    sleepMs?: number;
  } = {},
): void {
  const profile = SHIM_PROFILES[fixture.toolId];
  writeContractShim({
    dir: fixture.shimDir,
    command: CLI_TOOL_CATALOG[fixture.toolId].command,
    profile,
    mode,
    projectDir: fixture.projectDir,
    captureDir: fixture.captureDir,
    targetRelPath: opts.targetRelPath ?? 'src/contract.ts',
    ...(opts.outsidePath !== undefined ? { outsidePath: opts.outsidePath } : {}),
    ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
    ...(opts.versionLine !== undefined ? { versionLine: opts.versionLine } : {}),
    ...(opts.versionExitCode !== undefined ? { versionExitCode: opts.versionExitCode } : {}),
    ...(opts.authExitCode !== undefined ? { authExitCode: opts.authExitCode } : {}),
    ...(opts.sleepMs !== undefined ? { sleepMs: opts.sleepMs } : {}),
  });
  refreshTrustedGate(fixture);
}

function createFixture(toolId: ImplementerCliToolId): Fixture {
  const projectDir = createTempDir(`cli-contract-${toolId}`);
  createTestGitRepo(projectDir);
  writeFileSync(join(projectDir, '.gitignore'), '.splitbrief/\n');
  const shimDir = createTempDir(`cli-contract-shim-${toolId}`);
  const captureDir = join(shimDir, 'capture');
  mkdirSync(captureDir, { recursive: true });
  const fixture: Fixture = {
    toolId,
    projectDir,
    shimDir,
    captureDir,
    restorePath: prependPath(shimDir),
    trustedGate: {
      tool: toolId,
      executable: { path: '', fingerprint: { dev: 0, ino: 0, size: 0, mtimeMs: 0 } },
    },
  };
  installShim(fixture, 'success-direct');
  fixture.trustedGate = trustedGateFor(toolId, shimDir);
  fixtures.push(fixture);
  return fixture;
}

async function runImplement(
  fixture: Fixture,
  opts: {
    mode?: ContractShimMode;
    config?: Partial<CliImplementerConfig>;
    signal?: AbortSignal;
  } = {},
) {
  if (opts.mode !== undefined) installShim(fixture, opts.mode);
  resetCapture(fixture);
  const config = makeConfig({ implementer: implementerConfig(fixture.toolId, opts.config) });
  const implementer = createCliImplementer(implementerConfig(fixture.toolId, opts.config), {
    trustedCli: fixture.trustedGate,
  });
  return implementer.implement({
    task: contractTask(),
    projectDir: fixture.projectDir,
    config,
    context: { ...defaultContext, dir: fixture.projectDir },
    onOutput: () => {},
    signal: opts.signal,
  });
}

function contractTask() {
  return makeTask({
    suggestedFiles: ['src/contract.ts'],
    description: `${PROMPT_HEAD}create the contract module${PROMPT_TAIL}`,
  });
}

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function resolveFixtureExecutable(fixture: Fixture) {
  refreshTrustedGate(fixture);
  return resolveCliExecutable({
    command: CLI_TOOL_CATALOG[fixture.toolId].command,
    projectDir: fixture.projectDir,
    trust: fixture.trustedGate.executable,
  });
}

function readCapturedPrompt(fixture: Fixture): string {
  const profile = SHIM_PROFILES[fixture.toolId];
  const parts: string[] = [];
  if (profile.transport === 'stdin' && existsSync(join(fixture.captureDir, 'stdin.txt'))) {
    parts.push(readFileSync(join(fixture.captureDir, 'stdin.txt'), 'utf8'));
  }
  if (existsSync(join(fixture.captureDir, 'argv.lines'))) {
    parts.push(readFileSync(join(fixture.captureDir, 'argv.lines'), 'utf8'));
  }
  return parts.join('\n');
}

function callResult(
  status: RunnerCallStatus,
  code = 'provider-error',
  message = 'provider failed',
): RunnerCallResult {
  const common = {
    callId: 'call-1',
    role: 'implementer' as const,
    backendKind: 'cli' as const,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    text: '',
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
  } satisfies Omit<RunnerCallResult, 'status' | 'error' | 'partial'>;

  if (status === 'completed') {
    return { ...common, status, error: null, partial: false };
  }
  return { ...common, status, error: { code, message }, partial: true };
}

beforeEach(() => {
  originalPath = process.env['PATH'];
});

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    fixture.restorePath();
    cleanupTempDir(fixture.shimDir);
    cleanupTempDir(fixture.projectDir);
  }
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
});

function seatArgs(toolId: ImplementerCliToolId, projectDir: string): readonly string[] {
  return CLI_IMPLEMENTER_ADAPTERS[toolId].buildArgs({
    prompt: CLI_PROMPT_SENTINEL,
    model: undefined,
    projectDir,
    configuredArgs: [],
  });
}

function flagValues(args: readonly string[], flag: string): readonly (string | undefined)[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));
}

describe('implementer workspace argv', () => {
  it.each(ADMITTED_IMPLEMENTER_IDS)('%s names no directory but the seat directory', (toolId) => {
    const args = seatArgs(toolId, '/seat');
    expect(args.filter((arg) => isAbsolute(arg) && arg !== '/seat')).toEqual([]);
  });

  it.each(FLAGGED_WORKSPACE_IDS)(
    '%s names the seat directory on its workspace flag, once',
    (toolId) => {
      const flag = WORKSPACE_FLAGS[toolId] ?? '';
      expect(flagValues(seatArgs(toolId, '/seat'), flag)).toEqual(['/seat']);
    },
  );

  it('keeps codex on the workspace-write sandbox rooted at its --cd directory', () => {
    const args = seatArgs('codex', '/seat');
    expect(flagValues(args, '--sandbox')).toEqual(['workspace-write']);
    expect(flagValues(args, '--cd')).toEqual(['/seat']);
  });
});

describe('Cursor and Antigravity admission', () => {
  it('admits Cursor and Antigravity on both seats', () => {
    expect(CURSOR_CLI_ADMISSION_VERDICT).toBe('PASS');
    expect(ANTIGRAVITY_CLI_ADMISSION_VERDICT).toBe('PASS');
    expect(IMPLEMENTER_CLI_TOOL_IDS).toContain('cursor');
    expect(IMPLEMENTER_CLI_TOOL_IDS).toContain('antigravity');
    expect(CLI_TOOL_CATALOG.cursor.admission.state).toBe('active');
    expect(CLI_TOOL_CATALOG.antigravity.admission.state).toBe('active');
    expect('antigravity' in CLI_IMPLEMENTER_ADAPTERS).toBe(true);
    expect(lookupCliPlannerAdapter('antigravity').descriptor.id).toBe('antigravity');
  });
});

describe.each(ADMITTED_IMPLEMENTER_IDS)('%s admitted implementer staged contract', (toolId) => {
  it('writes the declared file and round-trips the whole prompt through its transport', async () => {
    const fixture = createFixture(toolId);
    const targetPath = join(fixture.projectDir, 'src/contract.ts');

    resetCapture(fixture);
    const success = await runImplement(fixture);
    expect(success.success).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('generated\n');
    expect(readCapturedPrompt(fixture)).toContain(PROMPT_HEAD);
    expect(readCapturedPrompt(fixture)).toContain(PROMPT_TAIL);

    installShim(fixture, 'success-direct');
    resetCapture(fixture);
    const adapter = CLI_IMPLEMENTER_ADAPTERS[toolId];
    await invokeCliAdapter({
      adapter,
      invocation: {
        executable: fixture.trustedGate.executable,
        args: adapter.buildArgs({
          prompt: CLI_PROMPT_SENTINEL,
          model: undefined,
          projectDir: fixture.projectDir,
          configuredArgs: [],
        }),
        promptTransport: adapter.promptTransport,
        environment: shimEnvironment(),
        cwd: fixture.projectDir,
        timeoutMs: 5_000,
        signal: undefined,
      },
      prompt: LARGE_ARGV_PROMPT,
      callContext: {
        callId: `oversized-${toolId}`,
        role: 'implementer',
        backendKind: 'cli',
        runnerName: toolId,
      },
    });
    expect(readCapturedPrompt(fixture)).toContain('x'.repeat(100_000));
    if (SHIM_PROFILES[toolId].transport === 'argv') {
      expect(readCapturedPrompt(fixture)).toContain(PROMPT_HEAD);
      expect(readCapturedPrompt(fixture)).toContain(PROMPT_TAIL);
    }
  }, 60_000);

  it('spawns the tool in the seat directory, so a relative write lands there', async () => {
    const fixture = createFixture(toolId);

    const result = await runImplement(fixture, { mode: 'cwd-relative-write' });
    expect(result.success).toBe(true);
    expect(readFileSync(join(fixture.projectDir, 'src/contract.ts'), 'utf8')).toBe(
      `${realpathSync(fixture.projectDir)}\n`,
    );
  }, 60_000);

  it('reports no-staged-change for no-op, outside-project and provider-state-only runs', async () => {
    const fixture = createFixture(toolId);

    installShim(fixture, 'no-op');
    const noChange = await runImplement(fixture);
    expect(noChange.success).toBe(false);
    expect(noChange.error).toContain('without changing any files');
    installShim(fixture, 'outside-write', {
      outsidePath: join(fixture.shimDir, 'outside-write.txt'),
    });
    const outside = await runImplement(fixture);
    expect(outside.success).toBe(false);
    expect(outside.error).toContain('without changing any files');
    expect(existsSync(join(fixture.shimDir, 'outside-write.txt'))).toBe(true);

    installShim(fixture, 'provider-state-write');
    const providerOnly = await runImplement(fixture);
    expect(providerOnly.success).toBe(false);
    expect(providerOnly.error).toContain('without changing any files');
    expect(existsSync(join(fixture.projectDir, '.splitbrief/provider-state.json'))).toBe(true);
  }, 60_000);

  it('fails a non-zero exit and a violated terminal protocol', async () => {
    const fixture = createFixture(toolId);

    installShim(fixture, 'non-zero-exit', { exitCode: 17 });
    const nonzero = await runImplement(fixture);
    expect(nonzero.success).toBe(false);

    if (isStructuredTerminal(toolId)) {
      installShim(fixture, 'protocol-failure');
      const protocol = await runImplement(fixture);
      expect(protocol.success).toBe(false);

      installShim(fixture, 'partial-protocol');
      const partial = await runImplement(fixture);
      expect(partial.success).toBe(false);
    }
  }, 60_000);

  it('classifies a missing executable, an incompatible version, an auth failure and an untrusted gate', async () => {
    const fixture = createFixture(toolId);

    const missingExecutable = join(fixture.shimDir, 'missing-executable');
    const missing = await invokeCliAdapter({
      adapter: CLI_IMPLEMENTER_ADAPTERS[toolId],
      invocation: {
        executable: {
          path: missingExecutable,
          fingerprint: { dev: 0, ino: 0, size: 0, mtimeMs: 0 },
        },
        args: CLI_IMPLEMENTER_ADAPTERS[toolId].buildArgs({
          prompt: CLI_PROMPT_SENTINEL,
          model: undefined,
          projectDir: fixture.projectDir,
          configuredArgs: [],
        }),
        promptTransport: CLI_IMPLEMENTER_ADAPTERS[toolId].promptTransport,
        environment: shimEnvironment(),
        cwd: fixture.projectDir,
        timeoutMs: 5_000,
        signal: undefined,
      },
      prompt: FULL_PROMPT,
      callContext: {
        callId: `missing-${toolId}`,
        role: 'implementer',
        backendKind: 'cli',
        runnerName: toolId,
      },
    });
    expect(missing.error?.code).toBe('spawn-not-found');

    installShim(fixture, 'success-direct', {
      versionLine: canonicalVersionLine(
        toolId,
        toolId === 'cursor' ? '2020.01.01-incompatible' : '0.0.1',
      ),
    });
    const incompatibleExecutable = await resolveFixtureExecutable(fixture);
    const incompatible = await probeCliReadiness({
      tool: toolId,
      executable: incompatibleExecutable,
      probe: CLI_IMPLEMENTER_ADAPTERS[toolId].probe,
      authChannel: AUTH_CHANNELS[toolId],
      classifyVersion: () => 'incompatible',
    });
    expect(incompatible.compatibility).toBe('incompatible');

    installShim(fixture, 'success-direct', { authExitCode: 1 });
    const unauthenticatedExecutable = await resolveFixtureExecutable(fixture);
    const authFailure = await withSeededSessionStateHome(toolId, () =>
      probeCliReadiness({
        tool: toolId,
        executable: unauthenticatedExecutable,
        probe: CLI_IMPLEMENTER_ADAPTERS[toolId].probe,
        authChannel: AUTH_CHANNELS[toolId],
      }),
    );
    // Readiness projects the adapter-declared fact: no generic version or
    // exit-code fallback is allowed to authenticate a probe-bearing adapter.
    expect(authFailure.auth).toBe(AUTH_FAILURE_FACTS_BY_PROBE_CONTRACT[toolId]);

    const untrusted = await createCliImplementer(implementerConfig(toolId), {
      trustedCli: undefined,
    }).implement({
      task: contractTask(),
      projectDir: fixture.projectDir,
      config: makeConfig({ implementer: implementerConfig(toolId) }),
      context: { ...defaultContext, dir: fixture.projectDir },
      onOutput: () => {},
    });
    expect(untrusted.success).toBe(false);
    expect(untrusted.error).toContain('trusted readiness identity');
  }, 60_000);

  it('refuses conflicting configured args without spawning the tool', async () => {
    const fixture = createFixture(toolId);
    const conflictMarker = join(fixture.captureDir, 'conflict-spawned.txt');
    writeConflictProbeShim({
      dir: fixture.shimDir,
      command: CLI_TOOL_CATALOG[toolId].command,
      markerPath: conflictMarker,
    });
    refreshTrustedGate(fixture);
    const conflict = await runImplement(fixture, {
      config: { args: [...CONFLICTING_ARGS[toolId]] },
    });
    expect(conflict.success).toBe(false);
    expect(existsSync(conflictMarker)).toBe(false);
  }, 60_000);

  it('times out a run that outlives its configured budget', async () => {
    const fixture = createFixture(toolId);
    installShim(fixture, 'timeout', { sleepMs: 5_000 });
    const timeoutImplementer = createCliImplementer(implementerConfig(toolId, { timeout: 50 }), {
      trustedCli: fixture.trustedGate,
    });
    const result = await timeoutImplementer.implement({
      task: makeTask({ suggestedFiles: ['src/contract.ts'] }),
      projectDir: fixture.projectDir,
      config: makeConfig({ implementer: implementerConfig(toolId, { timeout: 50 }) }),
      context: { ...defaultContext, dir: fixture.projectDir },
      onOutput: () => {},
    });
    expect(result).toMatchObject({ success: false, outcome: 'timeout' });
  }, 60_000);

  it('stages the declared file inside a conflicted repository', async () => {
    const fixture = createFixture(toolId);
    const targetPath = join(fixture.projectDir, 'src/contract.ts');
    startConflictingMerge(fixture.projectDir);
    installShim(fixture, 'success-direct');
    const conflictRepo = await runImplement(fixture);
    expect(conflictRepo.success).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('generated\n');
  }, 60_000);

  it('classifies signal exit, output flood and consumer callback failures', async () => {
    const fixture = createFixture(toolId);
    const adapter = CLI_IMPLEMENTER_ADAPTERS[toolId];
    const env = CREDENTIAL_ENV[toolId] ?? {};
    const previousEnv = Object.fromEntries(
      Object.keys(env).map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
    try {
      installShim(fixture, 'signal-exit');
      resetCapture(fixture);
      const signalResult = await invokeCliAdapter({
        adapter,
        invocation: {
          executable: fixture.trustedGate.executable,
          args: adapter.buildArgs({
            prompt: CLI_PROMPT_SENTINEL,
            model: undefined,
            projectDir: fixture.projectDir,
            configuredArgs: [],
          }),
          promptTransport: adapter.promptTransport,
          environment: shimEnvironment(env),
          cwd: fixture.projectDir,
          timeoutMs: 5_000,
          signal: undefined,
        },
        prompt: FULL_PROMPT,
        callContext: {
          callId: `signal-${toolId}`,
          role: 'implementer',
          backendKind: 'cli',
          runnerName: toolId,
        },
      });
      expect(signalResult.status).toBe('failed');
      expect(signalResult.error?.code).toBe('signal-exit');

      installShim(fixture, 'output-flood');
      resetCapture(fixture);
      const flood = await invokeCliAdapter({
        adapter,
        invocation: {
          executable: fixture.trustedGate.executable,
          args: adapter.buildArgs({
            prompt: CLI_PROMPT_SENTINEL,
            model: undefined,
            projectDir: fixture.projectDir,
            configuredArgs: [],
          }),
          promptTransport: adapter.promptTransport,
          environment: shimEnvironment(env),
          cwd: fixture.projectDir,
          timeoutMs: 5_000,
          signal: undefined,
        },
        prompt: FULL_PROMPT,
        callContext: {
          callId: `flood-${toolId}`,
          role: 'implementer',
          backendKind: 'cli',
          runnerName: toolId,
        },
      });
      if (adapter.outputContract.kind === 'structured-terminal') {
        expect(flood.status).toBe('incomplete');
        expect(flood.warnings.map((warning) => warning.code)).toContain('stdout_line_overflow');
      }

      installShim(fixture, 'success-direct');
      const callback = await invokeCliAdapter({
        adapter,
        invocation: {
          executable: fixture.trustedGate.executable,
          args: adapter.buildArgs({
            prompt: CLI_PROMPT_SENTINEL,
            model: undefined,
            projectDir: fixture.projectDir,
            configuredArgs: [],
          }),
          promptTransport: adapter.promptTransport,
          environment: shimEnvironment(env),
          cwd: fixture.projectDir,
          timeoutMs: 5_000,
          signal: undefined,
        },
        prompt: FULL_PROMPT,
        callContext: {
          callId: `callback-${toolId}`,
          role: 'implementer',
          backendKind: 'cli',
          runnerName: toolId,
        },
        onCallEvent: (event) => {
          if (event.type === 'call_completed') throw new Error('consumer failed');
        },
      });
      expect(callback.status).toBe('failed');
      expect(callback.error?.code).toBe('callback-failure');
    } finally {
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 60_000);

  it.skipIf(process.platform === 'win32')(
    'aborts and reaps descendant processes',
    async () => {
      const fixture = createFixture(toolId);
      installShim(fixture, 'abort-wait');
      resetCapture(fixture);
      refreshTrustedGate(fixture);
      const controller = new AbortController();
      const adapter = CLI_IMPLEMENTER_ADAPTERS[toolId];
      const startedMarker = join(fixture.captureDir, 'started.marker');
      const descendantPidFile = join(fixture.captureDir, 'descendant.pid');
      const invokePromise = invokeCliAdapter({
        adapter,
        invocation: {
          executable: fixture.trustedGate.executable,
          args: adapter.buildArgs({
            prompt: CLI_PROMPT_SENTINEL,
            model: undefined,
            projectDir: fixture.projectDir,
            configuredArgs: [],
          }),
          promptTransport: adapter.promptTransport,
          environment: shimEnvironment(),
          cwd: fixture.projectDir,
          timeoutMs: 5_000,
          signal: controller.signal,
        },
        prompt: FULL_PROMPT,
        callContext: {
          callId: `abort-${toolId}`,
          role: 'implementer',
          backendKind: 'cli',
          runnerName: toolId,
        },
      });
      for (let attempt = 0; attempt < 100 && !existsSync(startedMarker); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The shim's redirection creates the file before it writes the pid into it, so wait for the
      // content rather than the name; under load the two are far enough apart to read an empty file.
      await vi.waitFor(
        () => {
          expect(readFileSync(descendantPidFile, 'utf8').trim()).not.toBe('');
        },
        { timeout: 4_000, interval: 25 },
      );
      expect(existsSync(startedMarker)).toBe(true);
      const descendantPid = Number.parseInt(readFileSync(descendantPidFile, 'utf8'), 10);
      expect(descendantPid).toBeGreaterThan(1);
      expect(processIsAbsent(descendantPid)).toBe(false);
      controller.abort();
      const aborted = await invokePromise;
      expect(aborted.status).toBe('aborted');
      expect(aborted.error?.code).toBe('runner_interrupted');
      await vi.waitFor(() => expect(processIsAbsent(descendantPid)).toBe(true), {
        timeout: 1_100,
        interval: 10,
      });
    },
    30_000,
  );
});

describe('T-017 stable CLI outcome taxonomy', () => {
  it('covers every declared runner outcome state', () => {
    const covered = new Set<string>([
      'success',
      'spawn-not-found',
      'incompatible-version',
      'unauthenticated',
      'usage-limit',
      'input-too-large',
      'timeout',
      'user-abort',
      'signal-exit',
      'non-zero-exit',
      'protocol-failure',
      'output-budget-breach',
      'callback-failure',
      'no-staged-change',
      'platform-limitation',
      'implementer-effect-invalid',
      'implementer-recipe-invalid',
      'implementer-left-isolation',
      'checkout-changed',
      'runner-timeout-repeated',
      'missing-model',
      'no-progress-cut',
      'tool-use-limit',
    ]);
    expect([...RUNNER_OUTCOME_STATES].sort()).toEqual([...covered].sort());
  });

  it('maps input-too-large to input-too-large', () => {
    expect(runnerCallOutcome(callResult('failed', 'input-too-large')).state).toBe(
      'input-too-large',
    );
  });

  it('maps no-staged-change to no-staged-change', () => {
    expect(runnerCallOutcome(callResult('failed', 'no-staged-change')).state).toBe(
      'no-staged-change',
    );
  });

  it('maps unsupported_tool to platform-limitation', () => {
    const result = callResult('unsupported_tool', 'unsupported-tool');
    expect(runnerCallOutcome(result).state).toBe('platform-limitation');
  });

  it('maps usage-limit codes and limit turn diagnostics to usage-limit', () => {
    expect(runnerCallOutcome(callResult('failed', 'usage-limit')).state).toBe('usage-limit');
    // The live codex limit failure arrives as an ordinary turn failure whose
    // message is the only signal; it must classify as usage-limit, not auth.
    const limitTurn = callResult(
      'failed',
      'codex-turn-failed',
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM.",
    );
    expect(runnerCallOutcome(limitTurn).state).toBe('usage-limit');
  });
});
