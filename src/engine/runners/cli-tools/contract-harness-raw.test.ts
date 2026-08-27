import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  type CliProcessResult,
  type CliProcessRunner,
} from './contract-harness.js';
import { runRawCliConformance } from './contract-harness-raw.js';
import { replacePromptSentinel } from './candidate-contract.js';
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

describe('CLI raw conformance lane', () => {
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

  it('delivers the final-line prompt through argv, stdin, and mode-0600 file transport', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'splitbrief-cli-harness-'));
    const expectedPrompt = CONFORMANCE_PROMPT;
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
});
