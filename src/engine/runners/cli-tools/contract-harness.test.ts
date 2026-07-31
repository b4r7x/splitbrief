import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  runProductionCliConformance,
  runRawCliConformance,
  type CliProcessResult,
  type CliProcessRunner,
} from './contract-harness.js';
import {
  cliContractSha256,
  replacePromptSentinel,
  type RawCliCandidateContract,
} from './candidate-contract.js';
import { invokeProcessCli } from './process-invoke.js';
import type { CliImplementerAdapter } from './contract.js';

async function currentExecutableIdentity(): Promise<CliExecutableIdentity> {
  const path = process.execPath;
  const info = await stat(path);
  return {
    path,
    fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
  };
}

const processResult = (stdout = 'ok'): CliProcessResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
  signal: null,
  timedOut: false,
  outputExceeded: false,
});

const baseContract = {
  id: 'fixture-cli',
  command: 'fixture-cli',
  role: 'planner' as const,
  versionArgs: ['--version'],
  auth: { kind: 'none', env: [] as const },
  rawInvocation: ['--prompt', '<PROMPT>'],
  promptTransport: 'argv' as const,
  expectedRawTerminal: 'process-exit',
  asOf: '2026-07-31',
};

function rawOptions(contract: unknown, processRunner: CliProcessRunner, recordPath: string) {
  return {
    contractJson: JSON.stringify(contract),
    recordPath,
    projectDir: join(tmpdir(), 'unused-cli-project'),
    resolveExecutable: currentExecutableIdentity,
    processRunner,
  };
}

async function moduleWithCandidate(
  directory: string,
  contract: typeof baseContract,
  role: 'planner' | 'implementer' = 'planner',
): Promise<string> {
  const candidate = { ...contract, role };
  const hash = cliContractSha256(candidate);
  const path = join(directory, 'candidate.mjs');
  const source = `
export const CLI_CONFORMANCE_CANDIDATES = [{
  id: ${JSON.stringify(candidate.id)},
  role: ${JSON.stringify(role)},
  rawContract: ${JSON.stringify(candidate)},
  contractSha256: ${JSON.stringify(hash)},
  adapter: {
    descriptor: { id: ${JSON.stringify(candidate.id)} },
    role: ${JSON.stringify(role)},
    promptTransport: { kind: 'argv', maxBytes: 120000 },
    buildArgs: () => ['-e', 'process.stdout.write("ok")', '<PROMPT>'],
    validateArgs: () => ({ valid: true }),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: () => [],
    terminal: () => ({ type: 'result', status: 'completed', text: 'ok', usage: null, nativeSessionId: null, error: null, partial: false }),
    probe: { version: { command: ['fixture-cli', '--version'], cwd: 'neutral', timeoutMs: 100, maxOutputBytes: 1024 }, auth: { command: ['fixture-cli', 'auth'], cwd: 'neutral', timeoutMs: 100, maxOutputBytes: 1024 } }
  }
}];
`;
  await writeFile(path, source, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

type CandidateModuleOptions = Readonly<{
  readonly buildArgs?: string;
  readonly validateArgs?: string;
  readonly promptTransport?: string;
  readonly outputContract?: string;
  readonly parse?: string;
  readonly terminal?: string;
}>;

async function moduleWithCustomCandidate(
  directory: string,
  contract: RawCliCandidateContract,
  options: CandidateModuleOptions = {},
): Promise<string> {
  const candidate = { ...contract };
  const hash = cliContractSha256(candidate);
  const buildArgs =
    options.buildArgs ??
    `() => ['-e', ${JSON.stringify('process.stdout.write("ok")')}, '<PROMPT>']`;
  const validateArgs = options.validateArgs ?? '() => ({ valid: true })';
  const promptTransport =
    options.promptTransport ??
    (candidate.promptTransport === 'argv'
      ? `{ kind: 'argv', maxBytes: 120000 }`
      : candidate.promptTransport === 'stdin'
        ? `{ kind: 'stdin' }`
        : `{ kind: 'file', mode: 0o600 }`);
  const outputContract =
    options.outputContract ?? `{ kind: 'text-exit', successfulExitCodes: [0] }`;
  const parse = options.parse ?? '() => []';
  const terminal =
    options.terminal ??
    `() => ({ type: 'result', status: 'completed', text: 'ok', usage: null, nativeSessionId: null, error: null, partial: false })`;
  const path = join(directory, `${candidate.id}-${candidate.role}.mjs`);
  const source = `
export const CLI_CONFORMANCE_CANDIDATES = [{
  id: ${JSON.stringify(candidate.id)},
  role: ${JSON.stringify(candidate.role)},
  rawContract: ${JSON.stringify(candidate)},
  contractSha256: ${JSON.stringify(hash)},
  adapter: {
    descriptor: { id: ${JSON.stringify(candidate.id)} },
    role: ${JSON.stringify(candidate.role)},
    promptTransport: ${promptTransport},
    buildArgs: ${buildArgs},
    validateArgs: ${validateArgs},
    environment: {},
    outputContract: ${outputContract},
    parse: ${parse},
    terminal: ${terminal},
    probe: { version: { command: ['fixture-cli', '--version'], cwd: 'neutral', timeoutMs: 100, maxOutputBytes: 1024 }, auth: { command: ['fixture-cli', 'auth'], cwd: 'neutral', timeoutMs: 100, maxOutputBytes: 1024 } }
  }
}];
`;
  await writeFile(path, source, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('CLI conformance harness', () => {
  it('captures raw argv evidence before parser or adapter code exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const recordPath = join(directory, 'raw.json');
      const calls: Array<{ args: readonly string[]; stdin: string | undefined }> = [];
      const outcome = await runRawCliConformance(
        rawOptions(
          baseContract,
          async (options) => {
            calls.push({ args: options.args, stdin: options.stdin });
            return processResult();
          },
          recordPath,
        ),
      );
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      expect(calls).toHaveLength(2);
      expect(calls.at(-1)?.args).toEqual(['--prompt', expect.any(String)]);
      expect(calls.at(-1)?.args.at(-1)).not.toBe('<PROMPT>');
      const evidence = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(evidence)).toEqual(['rawCapture']);
      expect(evidence).not.toHaveProperty('verdict');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects every invalid prompt placeholder before a process runner is called', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      let spawned = false;
      const runner = async () => {
        spawned = true;
        return processResult();
      };
      const invalid = [
        ['--prompt'],
        ['--prompt', '<PROMPT>', '<PROMPT>'],
        ['--prompt', 'x<PROMPT>'],
        ['--prompt', '<OTHER>'],
      ];
      for (const rawInvocation of invalid) {
        const outcome = await runRawCliConformance(
          rawOptions(
            { ...baseContract, rawInvocation },
            runner,
            join(directory, `${invalid.indexOf(rawInvocation)}.json`),
          ),
        );
        expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE);
      }
      expect(spawned).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects stdin and file contracts containing any sentinel or angle placeholder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      let spawned = false;
      const runner = async () => {
        spawned = true;
        return processResult();
      };
      for (const promptTransport of ['stdin', 'file'] as const) {
        const outcome = await runRawCliConformance(
          rawOptions(
            { ...baseContract, promptTransport, rawInvocation: ['--prompt', '<PROMPT>'] },
            runner,
            join(directory, `${promptTransport}.json`),
          ),
        );
        expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE);
      }
      expect(spawned).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reuses raw evidence and selects the explicit role from the named export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const recordPath = join(directory, 'evidence.json');
      const raw = await runRawCliConformance(
        rawOptions(baseContract, async () => processResult(), recordPath),
      );
      expect(raw.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      const modulePath = await moduleWithCandidate(directory, baseContract);
      const production = await runProductionCliConformance({
        modulePath,
        role: 'planner',
        recordPath,
        projectDir: directory,
        resolveExecutable: currentExecutableIdentity,
      });
      expect(production.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      const evidence = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
      expect(evidence).toHaveProperty('verdict', 'PASS');
      expect(evidence).toHaveProperty('productionConformance');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed for absent raw evidence, wrong role, and a missing named export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const missingRecord = await runProductionCliConformance({
        modulePath: join(directory, 'missing.mjs'),
        role: 'planner',
        recordPath: join(directory, 'absent.json'),
        projectDir: directory,
      });
      expect(missingRecord.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE);

      const recordPath = join(directory, 'evidence.json');
      await writeFile(
        recordPath,
        JSON.stringify({
          rawCapture: {
            candidateId: baseContract.id,
            role: baseContract.role,
            contractSha256: cliContractSha256(baseContract),
            stdout: '',
            stderr: '',
          },
        }),
      );
      const wrongExport = join(directory, 'wrong.mjs');
      await writeFile(wrongExport, 'export const CANDIDATES = [];\n');
      const wrong = await runProductionCliConformance({
        modulePath: wrongExport,
        role: 'planner',
        recordPath,
        projectDir: directory,
      });
      expect(wrong.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE);

      const validModule = await moduleWithCandidate(directory, baseContract);
      const roleMiss = await runProductionCliConformance({
        modulePath: validModule,
        role: 'implementer',
        recordPath,
        projectDir: directory,
      });
      expect(roleMiss.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('delivers the final-line prompt through argv, stdin, and mode-0600 file transport', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    const expectedPrompt =
      'Implement the requested change in the staged project.\n\nFiles:\n- src/example.ts\n- tests/example.test.ts\n\nReturn a concise result.';
    const multibytePrompt = 'Zażółć gęślą jaźń — 日本語 🧪\nfinál';
    try {
      const replaced = replacePromptSentinel(['--prompt', '<PROMPT>'], multibytePrompt, 'argv');
      expect(replaced).toEqual(['--prompt', multibytePrompt]);
      expect(Buffer.from(replaced[1] ?? '')).toEqual(Buffer.from(multibytePrompt));

      for (const promptTransport of ['argv', 'stdin', 'file'] as const) {
        const calls: Array<{ args: readonly string[]; stdin: string | undefined }> = [];
        const runner = async (options: Parameters<CliProcessRunner>[0]) => {
          calls.push({ args: options.args, stdin: options.stdin });
          if (options.args[0] === '--version') return processResult('fixture 1.0.0');
          if (promptTransport === 'argv') {
            expect(options.args.at(-1)).toBe(expectedPrompt);
            expect(options.args.at(-1)).not.toBe('<PROMPT>');
            expect(Buffer.from(options.args.at(-1) ?? '')).toEqual(Buffer.from(expectedPrompt));
          } else if (promptTransport === 'stdin') {
            expect(options.stdin).toBe(expectedPrompt);
            expect(options.args).not.toContain('<PROMPT>');
          } else {
            expect(options.stdin).toBeUndefined();
            const promptPath = options.args.at(-1);
            expect(promptPath).toBeDefined();
            expect(promptPath).not.toBe('<PROMPT>');
            expect(await readFile(promptPath ?? '', 'utf8')).toBe(expectedPrompt);
            expect((await stat(promptPath ?? '')).mode & 0o777).toBe(0o600);
          }
          return processResult('fixture terminal');
        };
        const contract =
          promptTransport === 'argv'
            ? baseContract
            : { ...baseContract, promptTransport, rawInvocation: ['--mode', 'final'] };
        const outcome = await runRawCliConformance(
          rawOptions(contract, runner, join(directory, `${promptTransport}.json`)),
        );
        expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
        expect(calls).toHaveLength(2);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs the version/auth probes and fails closed for timeout and abort-shaped results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const calls: readonly string[][] = [];
      const observed: string[][] = [];
      const authenticated = {
        ...baseContract,
        id: 'fixture-auth-cli',
        auth: { kind: 'os-keyring-or-official-login', env: [] as const },
      };
      const runner = async (options: Parameters<CliProcessRunner>[0]) => {
        observed.push([...options.args]);
        if (options.args[0] === '--version') return processResult('fixture 1.0.0');
        if (options.args[0] === 'auth') return processResult('authenticated');
        return processResult();
      };
      const pass = await runRawCliConformance(
        rawOptions(authenticated, runner, join(directory, 'auth.json')),
      );
      expect(pass.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      expect(observed).toContainEqual(['--version']);
      expect(observed).toContainEqual(['auth']);
      expect(observed).toHaveLength(3);

      let invocation = false;
      const timedOut = await runRawCliConformance(
        rawOptions(
          baseContract,
          async (options) => {
            if (options.args[0] === '--version') return processResult('fixture 1.0.0');
            invocation = true;
            return {
              stdout: '',
              stderr: '',
              exitCode: null,
              signal: 'SIGTERM',
              timedOut: true,
              outputExceeded: false,
            };
          },
          join(directory, 'timeout.json'),
        ),
      );
      expect(invocation).toBe(true);
      expect(timedOut.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(timedOut.verdict).toBe('OMIT');
      expect(calls).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an argv prompt that exceeds the adapter byte budget before spawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const recordPath = join(directory, 'oversized.json');
      const raw = await runRawCliConformance(
        rawOptions(baseContract, async () => processResult(), recordPath),
      );
      expect(raw.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      const marker = join(directory, 'spawned.txt');
      const modulePath = await moduleWithCustomCandidate(directory, baseContract, {
        promptTransport: `{ kind: 'argv', maxBytes: 1 }`,
        buildArgs: `() => ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`)}, '<PROMPT>']`,
      });
      const production = await runProductionCliConformance({
        modulePath,
        role: 'planner',
        recordPath,
        projectDir: directory,
        resolveExecutable: currentExecutableIdentity,
      });
      expect(production.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE);
      expect(production.reason).toContain('adapter rejected');
      expect(await fileExists(marker)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects adapter argument conflicts without spawning the candidate process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const recordPath = join(directory, 'conflict.json');
      const raw = await runRawCliConformance(
        rawOptions(baseContract, async () => processResult(), recordPath),
      );
      expect(raw.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      const marker = join(directory, 'spawned.txt');
      const modulePath = await moduleWithCustomCandidate(directory, baseContract, {
        validateArgs: `() => ({ valid: false, conflicts: ['--prompt', 'secret-value'] })`,
        buildArgs: `() => ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`)}, '<PROMPT>']`,
      });
      const production = await runProductionCliConformance({
        modulePath,
        role: 'planner',
        recordPath,
        projectDir: directory,
        resolveExecutable: currentExecutableIdentity,
      });
      expect(production.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE);
      expect(production.reason).toContain('adapter rejected');
      expect(await fileExists(marker)).toBe(false);
      const evidence = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
      expect(JSON.stringify(evidence)).not.toContain('secret-value');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('proves direct-change versus no-op implementer outcomes and text-exit terminal handling', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const changedContract = {
        ...baseContract,
        id: 'fixture-changing-cli',
        role: 'implementer' as const,
      };
      const changedRecord = join(directory, 'changed.json');
      const raw = await runRawCliConformance(
        rawOptions(changedContract, async () => processResult(), changedRecord),
      );
      expect(raw.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      const changedPath = join(directory, 'changed.txt');
      const changedModule = await moduleWithCustomCandidate(directory, changedContract, {
        buildArgs: `() => ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(changedPath)}, 'changed'); process.stdout.write('changed')`)}, '<PROMPT>']`,
      });
      const changed = await runProductionCliConformance({
        modulePath: changedModule,
        role: 'implementer',
        recordPath: changedRecord,
        projectDir: directory,
        resolveExecutable: currentExecutableIdentity,
      });
      expect(changed.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      expect(await fileExists(changedPath)).toBe(true);

      const noopContract = {
        ...baseContract,
        id: 'fixture-noop-cli',
        role: 'implementer' as const,
      };
      const noopRecord = join(directory, 'noop.json');
      const noopRaw = await runRawCliConformance(
        rawOptions(noopContract, async () => processResult(), noopRecord),
      );
      expect(noopRaw.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      const noopModule = await moduleWithCustomCandidate(directory, noopContract);
      const noop = await runProductionCliConformance({
        modulePath: noopModule,
        role: 'implementer',
        recordPath: noopRecord,
        projectDir: directory,
        resolveExecutable: currentExecutableIdentity,
      });
      expect(noop.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(noop.verdict).toBe('OMIT');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts structured terminal output and omits when its terminal is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const terminalContract = {
        ...baseContract,
        id: 'fixture-structured-cli',
        expectedRawTerminal: 'terminal',
      };
      const recordPath = join(directory, 'structured.json');
      const raw = await runRawCliConformance(
        rawOptions(terminalContract, async () => processResult('terminal'), recordPath),
      );
      expect(raw.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      const terminalEvent = `({ type: 'result', status: 'completed', text: 'terminal', usage: null, nativeSessionId: null, error: null, partial: false })`;
      const modulePath = await moduleWithCustomCandidate(directory, terminalContract, {
        outputContract: `{ kind: 'structured-terminal', terminalEvent: 'required' }`,
        buildArgs: `() => ['-e', ${JSON.stringify("process.stdout.write('terminal\\n')")}, '<PROMPT>']`,
        parse: `(line) => line === 'terminal' ? [${terminalEvent}] : []`,
        terminal: `() => ${terminalEvent}`,
      });
      const production = await runProductionCliConformance({
        modulePath,
        role: 'planner',
        recordPath,
        projectDir: directory,
        resolveExecutable: currentExecutableIdentity,
      });
      expect(production.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);

      const missingContract = { ...terminalContract, id: 'fixture-missing-terminal-cli' };
      const missingRecord = join(directory, 'missing-terminal.json');
      const missingRaw = await runRawCliConformance(
        rawOptions(missingContract, async () => processResult('terminal'), missingRecord),
      );
      expect(missingRaw.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      const missingModule = await moduleWithCustomCandidate(directory, missingContract, {
        outputContract: `{ kind: 'structured-terminal', terminalEvent: 'required' }`,
        buildArgs: `() => ['-e', ${JSON.stringify("process.stdout.write('not-terminal\\n')")}, '<PROMPT>']`,
        parse: `(line) => line === 'not-terminal' ? [{ type: 'text', channel: 'assistant', text: line }] : []`,
      });
      const missing = await runProductionCliConformance({
        modulePath: missingModule,
        role: 'planner',
        recordPath: missingRecord,
        projectDir: directory,
        resolveExecutable: currentExecutableIdentity,
      });
      expect(missing.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(missing.verdict).toBe('OMIT');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('aborts a real CLI process and reaps its descendant before returning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    const startedPath = join(directory, 'descendant-started.txt');
    const markerPath = join(directory, 'descendant-alive.txt');
    const childScript = `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, 'started'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'alive'), 1000);`;
    const parentScript = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
    try {
      const adapter = {
        descriptor: { id: 'fixture-abort-cli', auth: { channels: [] } },
        role: 'implementer',
        promptTransport: { kind: 'stdin' },
        buildArgs: () => ['-e', parentScript],
        validateArgs: () => ({ valid: true }),
        environment: {},
        outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
        parse: () => [],
        terminal: () => ({
          type: 'result',
          status: 'completed',
          text: '',
          usage: null,
          nativeSessionId: null,
          error: null,
          partial: false,
        }),
        probe: {
          version: {
            command: ['fixture-abort-cli', '--version'],
            cwd: 'neutral',
            timeoutMs: 100,
            maxOutputBytes: 1024,
          },
          auth: {
            command: ['fixture-abort-cli', 'auth'],
            cwd: 'neutral',
            timeoutMs: 100,
            maxOutputBytes: 1024,
          },
        },
      } as unknown as CliImplementerAdapter;
      const controller = new AbortController();
      const invocation = invokeProcessCli(adapter, {
        invocation: {
          executable: await currentExecutableIdentity(),
          args: ['-e', parentScript],
          promptTransport: { kind: 'stdin' },
          environment: {},
          cwd: directory,
          timeoutMs: 5_000,
          signal: controller.signal,
        },
        prompt: 'Zażółć gęślą jaźń — 日本語 🧪',
        callContext: {
          callId: 'cli-abort-reaping',
          role: 'implementer',
          backendKind: 'cli',
          runnerName: 'fixture-abort-cli',
        },
      });
      for (let attempt = 0; attempt < 50 && !(await fileExists(startedPath)); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await fileExists(startedPath)).toBe(true);
      controller.abort();
      const result = await invocation;
      expect(result).toMatchObject({
        status: 'aborted',
        error: { code: 'user-abort' },
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(await fileExists(markerPath)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
