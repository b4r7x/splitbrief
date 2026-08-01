import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SANDBOX_DIR } from '../../../core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import { toCliEnvironment } from '../invoke-cli-adapter.js';
import {
  createRunnerSandboxEnv,
  createSandboxEnv,
  sandboxCredentialValues,
} from '../sandbox-env.js';
import type { CliImplementerAdapter, CliInvocation, CliPromptTransport } from './contract.js';
import { invokeProcessCli } from './process-invoke.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

const callContext = {
  callId: 'secret-isolation-matrix',
  role: 'implementer',
  backendKind: 'cli',
  runnerName: 'fixture',
} as const;

const completed = {
  type: 'result',
  status: 'completed',
  text: '',
  usage: null,
  nativeSessionId: null,
  error: null,
  partial: false,
} as const;

let dirs: string[] = [];
const originalEnvValues = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!originalEnvValues.has(key)) originalEnvValues.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of originalEnvValues) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvValues.clear();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function adapter(promptTransport: CliPromptTransport): CliImplementerAdapter {
  return {
    descriptor: CLI_TOOL_CATALOG.codex,
    role: 'implementer',
    promptTransport,
    baseArgs: () => [],
    buildArgs: () => [],
    validateArgs: () => ({ valid: true }),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: (line) => {
      if (line.startsWith('TEXT:')) {
        return [
          {
            type: 'text',
            channel: 'assistant',
            text: Buffer.from(line.slice(5), 'base64').toString('utf8'),
          },
        ];
      }
      if (line === 'RESULT') return [completed];
      return [];
    },
    terminal: ({ stdout }) => ({ ...completed, text: stdout }),
    probe: {
      version: {
        command: ['fixture', '--version'],
        cwd: 'neutral',
        timeoutMs: 100,
        maxOutputBytes: 1024,
      },
      auth: { command: ['fixture', 'auth'], cwd: 'neutral', timeoutMs: 100, maxOutputBytes: 1024 },
    },
  };
}

function executableIdentity(candidate: string) {
  const path = realpathSync(candidate);
  const info = statSync(path);
  return {
    path,
    fingerprint: {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
    },
  };
}

function invocation(opts: {
  environment?: Readonly<Record<string, string>>;
  script: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): CliInvocation {
  return {
    executable: executableIdentity(process.execPath),
    args: ['-e', opts.script],
    promptTransport: { kind: 'stdin' },
    environment: opts.environment ?? {},
    cwd: tmpdir(),
    timeoutMs: opts.timeoutMs ?? 5_000,
    signal: opts.signal,
  };
}

async function run(
  selectedInvocation: CliInvocation,
  onEvent?: (event: RunnerCallEvent) => void,
  onSpawned?: (process: ChildProcess) => void,
) {
  return invokeProcessCli(adapter({ kind: 'stdin' }), {
    invocation: selectedInvocation,
    prompt: '',
    callContext,
    onEvent,
    onSpawned,
  });
}

describe('ambient secret stripping canary matrix', () => {
  it('strips ambient credential canaries from the sandbox env', async () => {
    const projectDir = createTempDir('secret-isolation-ambient');
    dirs.push(projectDir);
    setEnv('GITHUB_TOKEN', 'canary-secret-isolation-ambient-gh-1a2b');
    setEnv('XAI_API_KEY', 'canary-secret-isolation-ambient-xai-2b3c');
    setEnv('DATABASE_URL', 'postgres://user:canary-secret-isolation-ambient-db-3c4d@host/db');
    setEnv('STRIPE_SECRET_KEY', 'canary-secret-isolation-ambient-stripe-4d5e');
    setEnv('SPLITBRIEF_PUBLIC_FLAG', 'keep-me');

    const env = await createSandboxEnv(projectDir);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.SPLITBRIEF_PUBLIC_FLAG).toBeUndefined();
    expect(Object.values(env)).not.toContain('canary-secret-isolation-ambient-gh-1a2b');
  });

  it('preserves only the selected runner auth channel', async () => {
    const projectDir = createTempDir('secret-isolation-auth-channel');
    dirs.push(projectDir);
    setEnv('OPENAI_API_KEY', 'canary-secret-isolation-openai-5e6f');
    setEnv('ANTHROPIC_API_KEY', 'canary-secret-isolation-anthropic-6f7a');

    const session = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
    });
    const apiKey = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'api-key',
    });

    expect(session.OPENAI_API_KEY).toBeUndefined();
    expect(session.ANTHROPIC_API_KEY).toBeUndefined();
    expect(apiKey.OPENAI_API_KEY).toBe('canary-secret-isolation-openai-5e6f');
    expect(apiKey.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('real-HOME invisibility canary matrix', () => {
  const itUnix = process.platform === 'win32' ? it.skip : it;

  itUnix('never exposes the real HOME path in sandbox env values', async () => {
    const hostHome = createTempDir('secret-isolation-real-home-host');
    const projectDir = createTempDir('secret-isolation-real-home-project');
    const safeBin = createTempDir('secret-isolation-real-home-bin');
    dirs.push(hostHome, projectDir, safeBin);
    const projectBin = join(projectDir, 'bin');
    mkdirSync(projectBin);
    setEnv('HOME', hostHome);
    setEnv('PATH', [projectBin, '.', safeBin].join(delimiter));
    setEnv('PWD', join(hostHome, 'cwd-canary'));
    writeFileSync(
      join(hostHome, '.npmrc'),
      '//registry/:_authToken=canary-secret-isolation-npm-7a8b\n',
    );

    const env = await createSandboxEnv(projectDir);

    expect(env.HOME).toBe(join(projectDir, SANDBOX_DIR, 'home'));
    expect(Object.values(env)).not.toContain(hostHome);
    expect(existsSync(join(env.HOME as string, '.npmrc'))).toBe(false);
  });

  itUnix('does not symlink tool credential dirs from the real HOME', async () => {
    const hostHome = createTempDir('secret-isolation-credential-dirs');
    const projectDir = createTempDir('secret-isolation-credential-project');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.claude'), { recursive: true });
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(
      join(hostHome, '.claude', '.credentials.json'),
      '{"token":"canary-secret-isolation-claude-8b9c"}',
    );
    setEnv('HOME', hostHome);

    const env = await createSandboxEnv(projectDir);
    const sandboxHome = env.HOME as string;

    expect(existsSync(join(sandboxHome, '.claude'))).toBe(false);
    expect(existsSync(join(sandboxHome, '.codex'))).toBe(false);
    expect(Object.values(env)).not.toContain(hostHome);
  });
});

describe('readonly provider bridge canary matrix', () => {
  const itUnix = process.platform === 'win32' ? it.skip : it;

  itUnix('bridges only the selected CLI state snapshot and seals it read-only', async () => {
    const hostHome = createTempDir('secret-isolation-bridge-host');
    const projectDir = createTempDir('secret-isolation-bridge-project');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    mkdirSync(join(hostHome, '.claude'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), '{"account":"selected"}');
    writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"account":"unrelated"}');
    setEnv('HOME', hostHome);

    const env = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
    });
    const bridgedAuth = join(env.HOME as string, '.codex', 'auth.json');

    expect(readFileSync(bridgedAuth, 'utf8')).toBe('{"account":"selected"}');
    expect(existsSync(join(env.HOME as string, '.claude'))).toBe(false);
    expect(statSync(bridgedAuth).mode & 0o222).toBe(0);
    expect(() => writeFileSync(bridgedAuth, 'runner-mutation')).toThrow();
    expect(Object.values(env)).not.toContain(hostHome);
  });

  it('keeps bridged snapshot credential values only in non-enumerable redaction metadata', async () => {
    const hostHome = createTempDir('secret-isolation-bridge-redaction-host');
    const projectDir = createTempDir('secret-isolation-bridge-redaction-project');
    dirs.push(hostHome, projectDir);
    const credential = 'canary-secret-isolation-bridge-9c0d';
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), JSON.stringify({ token: credential }));
    setEnv('HOME', hostHome);

    const env = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
    });

    expect(sandboxCredentialValues(env)).toContain(credential);
    expect(Object.keys(env)).not.toContain(credential);
    expect(Object.values(env)).not.toContain(credential);
    expect(JSON.stringify(env)).not.toContain(credential);
  });
});

describe('artifact log and snapshot redaction canary matrix', () => {
  it('redacts selected credentials from success, failure, abort, timeout, and debug output', async () => {
    const credential = 'canary-secret-isolation-redaction-0d1e';
    const environment = { OPENAI_API_KEY: credential };
    const outcomes: Array<{ result: Awaited<ReturnType<typeof run>>; events: RunnerCallEvent[] }> =
      [];

    const successEvents: RunnerCallEvent[] = [];
    outcomes.push({
      result: await run(
        invocation({
          environment,
          script:
            "const v=process.env.OPENAI_API_KEY;process.stdout.write('TEXT:'+Buffer.from(v).toString('base64')+'\\nRESULT\\n')",
        }),
        (event) => successEvents.push(event),
      ),
      events: successEvents,
    });

    const failureEvents: RunnerCallEvent[] = [];
    outcomes.push({
      result: await run(
        invocation({
          environment,
          script: "process.stderr.write('fatal debug '+process.env.OPENAI_API_KEY);process.exit(2)",
        }),
        (event) => failureEvents.push(event),
      ),
      events: failureEvents,
    });

    const abortController = new AbortController();
    const abortEvents: RunnerCallEvent[] = [];
    outcomes.push({
      result: await run(
        invocation({
          environment,
          signal: abortController.signal,
          script:
            "process.stderr.write('debug '+process.env.OPENAI_API_KEY);setInterval(()=>{},1000)",
        }),
        (event) => {
          abortEvents.push(event);
          if (event.type === 'call_stderr_delta') abortController.abort();
        },
      ),
      events: abortEvents,
    });

    const timeoutEvents: RunnerCallEvent[] = [];
    outcomes.push({
      result: await run(
        invocation({
          environment,
          timeoutMs: 30,
          script:
            "process.stderr.write('debug '+process.env.OPENAI_API_KEY);setInterval(()=>{},1000)",
        }),
        (event) => timeoutEvents.push(event),
      ),
      events: timeoutEvents,
    });

    expect(outcomes.map(({ result }) => result.status)).toEqual([
      'completed',
      'failed',
      'aborted',
      'timeout',
    ]);
    const persisted = JSON.stringify(outcomes);
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
  });

  it('redacts credentials read from a bridged CLI state snapshot before callbacks and persistence', async () => {
    const hostHome = createTempDir('secret-isolation-process-bridge-host');
    const projectDir = createTempDir('secret-isolation-process-bridge-project');
    dirs.push(hostHome, projectDir);
    const credential = 'canary-secret-isolation-snapshot-1e2f';
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(
      join(hostHome, '.codex', 'auth.json'),
      JSON.stringify({ token: credential, account: 'selected-account' }),
    );
    setEnv('HOME', hostHome);

    const sandboxEnv = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
    });
    const events: RunnerCallEvent[] = [];
    const result = await run(
      invocation({
        environment: toCliEnvironment(sandboxEnv),
        script:
          "const fs=require('node:fs');const path=require('node:path');const token=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.codex','auth.json'),'utf8')).token;process.stdout.write('TEXT:'+Buffer.from(token).toString('base64')+'\\nRESULT\\n');process.stderr.write('state='+token)",
      }),
      (event) => events.push(event),
    );

    const persisted = JSON.stringify({ result, events });
    expect(result.status).toBe('completed');
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
  });
});
