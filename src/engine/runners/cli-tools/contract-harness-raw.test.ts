import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  type CliProcessResult,
  type CliProcessRunner,
} from './contract-harness.js';
import { runRawCliConformance } from './contract-harness-raw.js';
import {
  CandidateEvidence,
  CONFORMANCE_PROMPT,
  MAX_EVIDENCE_OUTPUT_BYTES,
} from '../../providers/candidate-contract.js';

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
  rawInvocation: ['--print'],
  promptTransport: 'stdin' as const,
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

describe('CLI raw conformance lane', () => {
  it('captures raw evidence before parser or adapter code exists', async () => {
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
      expect(calls.at(-1)).toEqual({ args: ['--print'], stdin: CONFORMANCE_PROMPT });
      const evidence = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(evidence)).toEqual(['rawCapture']);
      expect(evidence).not.toHaveProperty('verdict');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('spawns every raw-lane process with the sanitized sandbox env: the contract credential, never the host secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-env-'));
    const planted = {
      FIXTURE_API_KEY: 'fake-fixture-key',
      SPLITBRIEF_FAKE_API_KEY: 'fake-api-key',
      CLAUDE_CODE_SESSION_ID: 'fake-session',
      SSH_AUTH_SOCK: '/tmp/fake-agent.sock',
    };
    const original = Object.fromEntries(Object.keys(planted).map((key) => [key, process.env[key]]));
    Object.assign(process.env, planted);
    try {
      const envs: string[][] = [];
      const outcome = await runRawCliConformance(
        rawOptions(
          { ...baseContract, auth: { kind: 'env-or-native', env: ['FIXTURE_API_KEY'] } },
          async (options) => {
            envs.push(Object.keys(options.env));
            return processResult();
          },
          join(directory, 'raw.json'),
        ),
      );

      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      expect(envs.length).toBeGreaterThan(0);
      for (const names of envs) {
        expect(names).toContain('FIXTURE_API_KEY');
        expect(names).not.toContain('SPLITBRIEF_FAKE_API_KEY');
        expect(names).not.toContain('SSH_AUTH_SOCK');
        expect(names.filter((name) => name.startsWith('CLAUDE_CODE_'))).toEqual([]);
      }
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('hands the staged project path to a tool whose raw contract places <PROJECT_DIR>', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const calls: Array<{ args: readonly string[]; cwd: string }> = [];
      const outcome = await runRawCliConformance(
        rawOptions(
          {
            ...baseContract,
            rawInvocation: ['--add-dir', '<PROJECT_DIR>', '--print'],
          },
          async (options) => {
            calls.push({ args: options.args, cwd: options.cwd });
            return processResult();
          },
          join(directory, 'raw.json'),
        ),
      );
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      const invocation = calls.at(-1);
      expect(invocation?.args).toEqual(['--add-dir', invocation?.cwd, '--print']);
      expect(isAbsolute(invocation?.args[1] ?? '')).toBe(true);
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
        ['--prompt', '<PROMPT>'],
        ['--prompt', 'x<PROMPT>'],
        ['--prompt', '<OTHER>'],
        ['--prompt', '{prompt}'],
        ['--add-dir=<PROJECT_DIR>', '--print'],
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

  it('bounds an oversized capture inside the evidence byte budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const recordPath = join(directory, 'raw.json');
      const flood = 'x'.repeat(MAX_EVIDENCE_OUTPUT_BYTES + 8_192);
      const outcome = await runRawCliConformance(
        rawOptions(baseContract, async () => processResult(flood), recordPath),
      );

      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      const record = JSON.parse(await readFile(recordPath, 'utf8')) as { rawCapture: unknown };
      const evidence = CandidateEvidence.safeParse({
        rawCapture: record.rawCapture,
        productionConformance: null,
        verdict: 'OMIT',
      });
      expect(evidence.success).toBe(true);
      expect(
        Buffer.byteLength(evidence.success ? evidence.data.rawCapture.stdout : '', 'utf8'),
      ).toBeLessThanOrEqual(MAX_EVIDENCE_OUTPUT_BYTES);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('delivers the prompt on stdin and keeps it out of the arguments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      const calls: Array<{ args: readonly string[]; stdin: string | undefined }> = [];
      const runner = async (options: Parameters<CliProcessRunner>[0]) => {
        calls.push({ args: options.args, stdin: options.stdin });
        if (options.args[0] === '--version') return processResult('fixture 1.0.0');
        return processResult('fixture terminal');
      };
      const outcome = await runRawCliConformance(
        rawOptions(baseContract, runner, join(directory, 'stdin.json')),
      );
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      expect(calls.at(-1)?.stdin).toBe(CONFORMANCE_PROMPT);
      expect(calls.at(-1)?.args).not.toContain(CONFORMANCE_PROMPT);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs the version/auth probes and fails closed for timeout and abort-shaped results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
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
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a raw contract that sends the prompt in argv or a file, before any spawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    try {
      let spawned = false;
      const runner = async () => {
        spawned = true;
        return processResult();
      };
      const contracts = [
        {
          ...baseContract,
          promptTransport: 'argv' as const,
          rawInvocation: ['--prompt', '<PROMPT>'],
        },
        { ...baseContract, promptTransport: 'file' as const, rawInvocation: ['--prompt-file'] },
      ];
      for (const contract of contracts) {
        const outcome = await runRawCliConformance(
          rawOptions(contract, runner, join(directory, `${contract.promptTransport}.json`)),
        );
        expect
          .soft(outcome.exitCode, contract.promptTransport)
          .toBe(CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE);
      }
      expect(spawned).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
