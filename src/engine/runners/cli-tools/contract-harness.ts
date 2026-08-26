import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { z } from 'zod';
import type { CliExecutableResolver } from '../resolve-cli-executable.js';
import { createBoundedOutput, type BoundedOutput } from '../../../lib/process/bounded-output.js';
import { isFatalSignal, spawnPipe } from '../../../lib/process/spawn/lifecycle.js';
import { createSandboxEnv } from '../sandbox-env.js';
import type { RawCliCandidateContract } from './candidate-contract.js';
import {
  type CandidateEvidence,
  CONFORMANCE_EXIT_CODES,
  MAX_EVIDENCE_OUTPUT_BYTES,
  contractSha256,
  sanitizeCandidateOutput,
} from '../../providers/candidate-contract.js';
import { isRecord } from '../../../utils/type-guards.js';
import { error as createError } from '../../../utils/error.js';

const execFileAsync = promisify(execFile);
export const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
export const INVOCATION_TIMEOUT_MS = 30_000;

export const CLI_CONFORMANCE_EXIT_CODES = CONFORMANCE_EXIT_CODES;

export type CliConformanceExitCode =
  (typeof CLI_CONFORMANCE_EXIT_CODES)[keyof typeof CLI_CONFORMANCE_EXIT_CODES];
export type CliConformanceVerdict = 'PASS' | 'OMIT';
export type CliConformanceRole = 'planner' | 'implementer';

export type CliConformanceEnvironment = Readonly<Record<string, string | undefined>>;

export type CliProcessResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputExceeded: boolean;
}>;

export type CliProcessRunner = (options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string | undefined;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
}) => Promise<CliProcessResult>;

export type CliConformanceOptions = Readonly<{
  projectDir?: string | undefined;
  environment?: CliConformanceEnvironment | undefined;
  processRunner?: CliProcessRunner | undefined;
  resolveExecutable?: CliExecutableResolver | undefined;
}>;

export type RawCliConformanceOptions = CliConformanceOptions &
  Readonly<{
    contractJson: string;
    recordPath: string;
  }>;

export type ProductionCliConformanceOptions = CliConformanceOptions &
  Readonly<{
    modulePath: string;
    role: CliConformanceRole;
    recordPath: string;
  }>;

export type CliConformanceOutcome = Readonly<{
  exitCode: CliConformanceExitCode;
  verdict: CliConformanceVerdict;
  candidateId?: string | undefined;
  role?: CliConformanceRole | undefined;
  reason?: string | undefined;
}>;

export type RawCapture = z.infer<typeof CandidateEvidence>['rawCapture'];

type ConformanceErrorCode = 'credentialed-omit' | 'harness-failure';

type ConformanceProject = Readonly<{
  path: string;
  cleanup: () => Promise<void>;
}>;

function conformanceError(code: ConformanceErrorCode, message: string): Error & { kind: string } {
  return createError(code, message);
}

export function hasConformanceCode(value: unknown, code: ConformanceErrorCode): boolean {
  return isRecord(value) && value.kind === code;
}

export function throwConformance(code: ConformanceErrorCode, message: string): never {
  throw conformanceError(code, message);
}

export function safeReason(value: unknown): string {
  const message = value instanceof Error ? value.message : 'CLI conformance failed';
  return sanitizeCandidateOutput(message, MAX_EVIDENCE_OUTPUT_BYTES);
}

function redactOutput(value: string, credentials: readonly string[]): string {
  let redacted = value;
  for (const credential of credentials) {
    if (credential.length > 0) redacted = redacted.replaceAll(credential, '[REDACTED]');
  }
  return sanitizeCandidateOutput(redacted, MAX_EVIDENCE_OUTPUT_BYTES);
}

function environmentValue(
  environment: CliConformanceEnvironment,
  name: string,
): string | undefined {
  const value = environment[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

export function credentialsForContract(
  contract: RawCliCandidateContract,
  environment: CliConformanceEnvironment,
): string[] {
  return contract.auth.env
    .map((name) => environmentValue(environment, name))
    .filter((value): value is string => value !== undefined);
}

export function hasRequiredCredential(
  contract: RawCliCandidateContract,
  environment: CliConformanceEnvironment,
): boolean {
  return contract.auth.env.length === 0 || credentialsForContract(contract, environment).length > 0;
}

function isProcessResult(value: unknown): value is CliProcessResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string' &&
    (typeof value.exitCode === 'number' || value.exitCode === null) &&
    (typeof value.signal === 'string' || value.signal === null) &&
    typeof value.timedOut === 'boolean' &&
    typeof value.outputExceeded === 'boolean'
  );
}

async function runBoundedProcess(
  options: Parameters<CliProcessRunner>[0],
): Promise<CliProcessResult> {
  if (process.platform === 'win32') {
    throwConformance('harness-failure', 'CLI conformance requires a tree-reaping platform');
  }
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), options.timeoutMs);
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  const stdout = createBoundedOutput({ maxBytes: options.maxOutputBytes, policy: 'tail' });
  const stderr = createBoundedOutput({ maxBytes: options.maxOutputBytes, policy: 'tail' });
  let outputExceeded = false;
  let outputBytesSeen = 0;
  const collect = (output: BoundedOutput, chunk: string): undefined => {
    outputBytesSeen += Buffer.byteLength(chunk, 'utf8');
    if (outputBytesSeen > options.maxOutputBytes) outputExceeded = true;
    output.append(chunk);
    return undefined;
  };
  const captured = (
    exitCode: number | null,
    processSignal: string | null,
    timedOut: boolean,
  ): CliProcessResult => ({
    stdout: stdout.snapshot().text,
    stderr: stderr.snapshot().text,
    exitCode,
    signal: processSignal,
    timedOut,
    outputExceeded,
  });

  try {
    const result = await spawnPipe<CliProcessResult>({
      command: options.command,
      args: [...options.args],
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      stdin: options.stdin,
      signal,
      outputBudgetBytes: options.maxOutputBytes * 2,
      partialStdoutMaxBytes: options.maxOutputBytes,
      partialStderrMaxBytes: options.maxOutputBytes,
      onStdout: (chunk) => collect(stdout, chunk),
      onStderr: (chunk) => collect(stderr, chunk),
      onClose: (exitCode, processSignal) =>
        captured(exitCode, processSignal, timeoutController.signal.aborted),
    });
    return isProcessResult(result)
      ? result
      : throwConformance('harness-failure', 'CLI process runner returned an invalid result');
  } catch (cause) {
    if (timeoutController.signal.aborted) return captured(null, null, true);
    if (isFatalSignal(cause) && cause.state === 'output-budget-breach') {
      outputExceeded = true;
      return captured(null, null, false);
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

export function processRunnerOf(options: CliConformanceOptions): CliProcessRunner {
  return options.processRunner ?? runBoundedProcess;
}

export async function createProject(projectDir: string | undefined): Promise<ConformanceProject> {
  if (projectDir !== undefined) {
    return { path: resolve(projectDir), cleanup: async () => {} };
  }
  const path = await mkdtemp(join(tmpdir(), 'splitbrief-cli-conformance-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], {
      cwd: path,
      env: { PATH: process.env.PATH ?? '' },
    });
  } catch {
    await rm(path, { recursive: true, force: true });
    throwConformance('harness-failure', 'could not create the staged git project');
  }
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export async function sandboxEnvironment(
  projectDir: string,
  contract: RawCliCandidateContract,
  provided: CliConformanceEnvironment | undefined,
): Promise<NodeJS.ProcessEnv> {
  const preserve = provided === undefined ? [...contract.auth.env] : [];
  const sandbox = await createSandboxEnv({ projectDir, preserveEnvKeys: preserve });
  if (provided === undefined) return sandbox;
  const result = { ...sandbox };
  for (const name of contract.auth.env) {
    const value = provided[name];
    if (value === undefined) delete result[name];
    else result[name] = value;
  }
  return result;
}

export function captureFor(opts: {
  contract: RawCliCandidateContract;
  stdout: string;
  stderr: string;
  credentials: readonly string[];
}): RawCapture {
  return {
    candidateId: opts.contract.id,
    role: opts.contract.role,
    contractSha256: contractSha256(opts.contract),
    stdout: redactOutput(opts.stdout, opts.credentials),
    stderr: redactOutput(opts.stderr, opts.credentials),
  };
}
export async function writeEvidenceFile(recordPath: string, content: string): Promise<void> {
  const path = resolve(recordPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${content}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}
