import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { INTERNAL_SKIP_DIRS } from '../../../core/paths.js';
import { RunnerCallResultSchema } from '../../calls/schema.js';
import type { RunnerCallContext, RunnerCallResult } from '../../calls/types.js';
import { createBoundedOutput, type BoundedOutput } from '../../../lib/process/bounded-output.js';
import { isFatalSignal, spawnPipe } from '../../../lib/process/spawn/lifecycle.js';
import { createSandboxEnv } from '../sandbox-env.js';
import { resolveCliExecutable } from '../resolve-cli-executable.js';
import { toCliEnvironment } from '../invoke-cli-adapter.js';
import { invokeProcessCli } from './process-invoke.js';
import type { CliProcessAdapter } from './contract.js';
import {
  CLI_PROMPT_SENTINEL,
  RawCliCandidateContract,
  type UnregisteredCliAdapter,
  type UnregisteredCliCandidate,
  candidateEvidenceWithCliCapture,
  parseCliConformanceCandidates,
  replacePromptSentinel,
} from './candidate-contract.js';
import {
  CandidateEvidence,
  CONFORMANCE_EXIT_CODES,
  CONFORMANCE_PROMPT,
  MAX_EVIDENCE_OUTPUT_BYTES,
  contractSha256,
  sanitizeCandidateOutput,
} from '../../providers/candidate-contract.js';
import { isRecord } from '../../../utils/type-guards.js';
import { error as createError } from '../../../utils/error.js';

const execFileAsync = promisify(execFile);
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const INVOCATION_TIMEOUT_MS = 30_000;
const PROJECT_FINGERPRINT_SKIP_DIRS = new Set([...INTERNAL_SKIP_DIRS, '.nuke']);

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

type CliConformanceOptions = Readonly<{
  projectDir?: string | undefined;
  environment?: CliConformanceEnvironment | undefined;
  processRunner?: CliProcessRunner | undefined;
  resolveExecutable?:
    | ((command: string, projectDir: string) => Promise<CliExecutableIdentity>)
    | undefined;
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

type RawCapture = z.infer<typeof CandidateEvidence>['rawCapture'];
type CandidateValue = z.infer<typeof UnregisteredCliCandidate>;

type ConformanceErrorCode = 'credentialed-omit' | 'harness-failure';

type ConformanceProject = Readonly<{
  path: string;
  cleanup: () => Promise<void>;
}>;

type PreparedPrompt = Readonly<{
  args: readonly string[];
  stdin: string | undefined;
  cleanup: () => Promise<void>;
}>;

function conformanceError(code: ConformanceErrorCode, message: string): Error & { kind: string } {
  return createError(code, message);
}

function hasConformanceCode(value: unknown, code: ConformanceErrorCode): boolean {
  return isRecord(value) && value.kind === code;
}

function throwConformance(code: ConformanceErrorCode, message: string): never {
  throw conformanceError(code, message);
}

function safeReason(value: unknown): string {
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

function credentialsForContract(
  contract: RawCliCandidateContract,
  environment: CliConformanceEnvironment,
): string[] {
  return contract.auth.env
    .map((name) => environmentValue(environment, name))
    .filter((value): value is string => value !== undefined);
}

function hasRequiredCredential(
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

function processRunnerOf(options: CliConformanceOptions): CliProcessRunner {
  return options.processRunner ?? runBoundedProcess;
}

async function createProject(projectDir: string | undefined): Promise<ConformanceProject> {
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

async function sandboxEnvironment(
  projectDir: string,
  contract: RawCliCandidateContract,
  provided: CliConformanceEnvironment | undefined,
): Promise<NodeJS.ProcessEnv> {
  const preserve = provided === undefined ? [...contract.auth.env] : [];
  const sandbox = await createSandboxEnv(projectDir, preserve);
  if (provided === undefined) return sandbox;
  const result = { ...sandbox };
  for (const name of contract.auth.env) {
    const value = provided[name];
    if (value === undefined) delete result[name];
    else result[name] = value;
  }
  return result;
}

function captureFor(
  contract: RawCliCandidateContract,
  stdout: string,
  stderr: string,
  credentials: readonly string[],
): RawCapture {
  return {
    candidateId: contract.id,
    role: contract.role,
    contractSha256: contractSha256(contract),
    stdout: redactOutput(stdout, credentials),
    stderr: redactOutput(stderr, credentials),
  };
}

async function writeRawRecord(recordPath: string, rawCapture: RawCapture): Promise<void> {
  await writeEvidenceFile(recordPath, JSON.stringify({ rawCapture }, null, 2));
}

async function writeProductionRecord(
  recordPath: string,
  rawCapture: RawCapture,
  productionConformance: RawCapture | null,
  verdict: CliConformanceVerdict,
): Promise<void> {
  const evidence = candidateEvidenceWithCliCapture(rawCapture, productionConformance, verdict);
  await writeEvidenceFile(recordPath, JSON.stringify(evidence, null, 2));
}

async function writeEvidenceFile(recordPath: string, content: string): Promise<void> {
  const path = resolve(recordPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${content}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

function expectedTerminalSeen(
  contract: RawCliCandidateContract,
  result: CliProcessResult,
): boolean {
  if (contract.expectedRawTerminal === 'process-exit') return result.exitCode === 0;
  return `${result.stdout}\n${result.stderr}`.includes(contract.expectedRawTerminal);
}

async function preparePrompt(
  contract: RawCliCandidateContract,
  prompt: string,
  directory: string,
): Promise<PreparedPrompt> {
  if (contract.promptTransport === 'argv') {
    return {
      args: replacePromptSentinel(contract.rawInvocation, prompt, 'argv'),
      stdin: undefined,
      cleanup: async () => {},
    };
  }
  if (contract.promptTransport === 'stdin') {
    return { args: [...contract.rawInvocation], stdin: prompt, cleanup: async () => {} };
  }
  const promptPath = join(directory, 'prompt.txt');
  await writeFile(promptPath, prompt, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await chmod(promptPath, 0o600);
  return {
    args: [...contract.rawInvocation, promptPath],
    stdin: undefined,
    cleanup: async () => {
      await rm(promptPath, { force: true });
    },
  };
}

async function runRawInvocation(
  contract: RawCliCandidateContract,
  executable: CliExecutableIdentity,
  projectDir: string,
  environment: NodeJS.ProcessEnv,
  processRunner: CliProcessRunner,
): Promise<{
  readonly result: CliProcessResult;
  readonly output: string;
  readonly errorText: string;
}> {
  const promptDir = await mkdtemp(join(tmpdir(), 'splitbrief-cli-prompt-'));
  let prepared: PreparedPrompt | undefined;
  try {
    prepared = await preparePrompt(contract, CONFORMANCE_PROMPT, promptDir);
    const result = await processRunner({
      command: executable.path,
      args: prepared.args,
      cwd: projectDir,
      env: environment,
      ...(prepared.stdin === undefined ? {} : { stdin: prepared.stdin }),
      timeoutMs: INVOCATION_TIMEOUT_MS,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    return {
      result,
      output: `${result.stdout}\n${result.stderr}`,
      errorText: result.timedOut ? 'CLI invocation timed out' : '',
    };
  } finally {
    await prepared?.cleanup();
    await rm(promptDir, { recursive: true, force: true });
  }
}

async function runRawProbes(
  contract: RawCliCandidateContract,
  executable: CliExecutableIdentity,
  projectDir: string,
  environment: NodeJS.ProcessEnv,
  processRunner: CliProcessRunner,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const version = await processRunner({
    command: executable.path,
    args: [...contract.versionArgs],
    cwd: projectDir,
    env: environment,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
  });
  const outputs = [`version exit=${version.exitCode}\n${version.stdout}`];
  const errors = [version.stderr];
  if (version.timedOut || version.exitCode !== 0 || version.outputExceeded) {
    throwConformance('credentialed-omit', 'CLI version probe did not complete successfully');
  }
  if (contract.auth.kind !== 'none' && contract.auth.kind !== 'env-only') {
    const auth = await processRunner({
      command: executable.path,
      args: ['auth'],
      cwd: projectDir,
      env: environment,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    outputs.push(`auth exit=${auth.exitCode}\n${auth.stdout}`);
    errors.push(auth.stderr);
  }
  return { stdout: outputs.join('\n'), stderr: errors.join('\n') };
}

export async function runRawCliConformance(
  options: RawCliConformanceOptions,
): Promise<CliConformanceOutcome> {
  let contract: RawCliCandidateContract;
  try {
    contract = RawCliCandidateContract.parse(JSON.parse(options.contractJson));
  } catch {
    return {
      exitCode: CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
      verdict: 'OMIT',
      reason: 'invalid CLI candidate contract',
    };
  }
  const project = await createProject(options.projectDir);
  try {
    const processRunner = processRunnerOf(options);
    const environment = await sandboxEnvironment(project.path, contract, options.environment);
    const credentials = credentialsForContract(contract, environment);
    if (!hasRequiredCredential(contract, environment)) {
      const capture = captureFor(contract, '', 'missing credential', credentials);
      await writeRawRecord(options.recordPath, capture);
      return {
        exitCode: CLI_CONFORMANCE_EXIT_CODES.OMIT,
        verdict: 'OMIT',
        candidateId: contract.id,
        role: contract.role,
        reason: 'required CLI credential is unavailable',
      };
    }
    const resolveExecutable = options.resolveExecutable ?? resolveCliExecutable;
    let executable: CliExecutableIdentity;
    try {
      executable = await resolveExecutable(contract.command, project.path);
    } catch (cause) {
      const capture = captureFor(contract, '', safeReason(cause), credentials);
      await writeRawRecord(options.recordPath, capture);
      return {
        exitCode: CLI_CONFORMANCE_EXIT_CODES.OMIT,
        verdict: 'OMIT',
        candidateId: contract.id,
        role: contract.role,
        reason: 'CLI executable is unavailable',
      };
    }

    let probeOutput: { readonly stdout: string; readonly stderr: string };
    let invocation: Awaited<ReturnType<typeof runRawInvocation>>;
    try {
      probeOutput = await runRawProbes(
        contract,
        executable,
        project.path,
        environment,
        processRunner,
      );
      invocation = await runRawInvocation(
        contract,
        executable,
        project.path,
        environment,
        processRunner,
      );
    } catch (cause) {
      const reason = safeReason(cause);
      const capture = captureFor(contract, '', reason, credentials);
      await writeRawRecord(options.recordPath, capture);
      const harness = hasConformanceCode(cause, 'harness-failure');
      return {
        exitCode: harness
          ? CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE
          : CLI_CONFORMANCE_EXIT_CODES.OMIT,
        verdict: 'OMIT',
        candidateId: contract.id,
        role: contract.role,
        reason,
      };
    }
    const stdout = `${probeOutput.stdout}\n${invocation.output}`;
    const stderr = `${probeOutput.stderr}\n${invocation.errorText}`;
    const capture = captureFor(contract, stdout, stderr, credentials);
    if (
      invocation.result.timedOut ||
      invocation.result.outputExceeded ||
      !expectedTerminalSeen(contract, invocation.result)
    ) {
      await writeRawRecord(options.recordPath, capture);
      return {
        exitCode: CLI_CONFORMANCE_EXIT_CODES.OMIT,
        verdict: 'OMIT',
        candidateId: contract.id,
        role: contract.role,
        reason: 'CLI raw capture did not satisfy the declared terminal contract',
      };
    }
    await writeRawRecord(options.recordPath, capture);
    return {
      exitCode: CLI_CONFORMANCE_EXIT_CODES.PASS,
      verdict: 'PASS',
      candidateId: contract.id,
      role: contract.role,
    };
  } finally {
    await project.cleanup();
  }
}

async function readRawRecord(recordPath: string): Promise<RawCapture> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(recordPath), 'utf8'));
  } catch {
    throwConformance('harness-failure', 'CLI evidence record is missing or invalid JSON');
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !('rawCapture' in parsed)) {
    throwConformance('harness-failure', 'CLI evidence record has no standalone rawCapture');
  }
  const evidence = CandidateEvidence.safeParse({
    rawCapture: parsed.rawCapture,
    productionConformance: null,
    verdict: 'OMIT',
  });
  if (!evidence.success) throwConformance('harness-failure', 'CLI rawCapture is invalid');
  return evidence.data.rawCapture;
}

async function loadCandidateModule(modulePath: string): Promise<readonly CandidateValue[]> {
  const resolvedPath = isAbsolute(modulePath) ? modulePath : resolve(modulePath);
  let moduleValue: unknown;
  try {
    moduleValue = await import(pathToFileURL(resolvedPath).href);
  } catch {
    throwConformance('harness-failure', 'CLI candidate module could not be loaded');
  }
  if (!isRecord(moduleValue) || !('CLI_CONFORMANCE_CANDIDATES' in moduleValue)) {
    throwConformance('harness-failure', 'CLI module must export CLI_CONFORMANCE_CANDIDATES');
  }
  try {
    return parseCliConformanceCandidates(moduleValue.CLI_CONFORMANCE_CANDIDATES);
  } catch {
    throwConformance('harness-failure', 'CLI candidate export failed strict contract parsing');
  }
}

function selectCandidate(
  candidates: readonly CandidateValue[],
  rawCapture: RawCapture,
  role: CliConformanceRole,
): CandidateValue {
  const matches = candidates.filter(
    (candidate) => candidate.id === rawCapture.candidateId && candidate.role === role,
  );
  if (matches.length !== 1) {
    throwConformance(
      'harness-failure',
      'CLI candidate and explicit role did not identify one entry',
    );
  }
  const [candidate] = matches;
  if (candidate === undefined) throwConformance('harness-failure', 'CLI candidate is missing');
  if (candidate.rawContract.role !== role || candidate.rawContract.id !== rawCapture.candidateId) {
    throwConformance('harness-failure', 'CLI candidate role or id does not match raw evidence');
  }
  const expectedHash = contractSha256(candidate.rawContract);
  if (expectedHash !== rawCapture.contractSha256 || candidate.contractSha256 !== expectedHash) {
    throwConformance('harness-failure', 'CLI contract hash does not match raw evidence');
  }
  return candidate;
}

function adapterArgs(adapter: UnregisteredCliAdapter, projectDir: string): readonly string[] {
  const result =
    adapter.role === 'planner'
      ? adapter.buildArgs({
          prompt: CLI_PROMPT_SENTINEL,
          model: undefined,
          projectDir,
          configuredArgs: [],
          mode: 'plan',
          sessionId: null,
          effort: undefined,
        })
      : adapter.buildArgs({
          prompt: CLI_PROMPT_SENTINEL,
          model: undefined,
          projectDir,
          configuredArgs: [],
        });
  if (!Array.isArray(result) || !result.every((value) => typeof value === 'string')) {
    throwConformance('harness-failure', 'CLI adapter returned invalid invocation arguments');
  }
  return [...result];
}

function processAdapter(
  adapter: UnregisteredCliAdapter,
  contract: RawCliCandidateContract,
): CliProcessAdapter {
  return {
    descriptor: { id: contract.id, auth: { channels: [{ env: [...contract.auth.env] }] } },
    promptTransport: adapter.promptTransport,
    validateArgs: adapter.validateArgs,
    outputContract: adapter.outputContract,
    parse: adapter.parse,
    terminal: adapter.terminal,
  };
}

async function projectFingerprint(projectDir: string): Promise<string> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && PROJECT_FINGERPRINT_SKIP_DIRS.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        files.push(
          `${relative(projectDir, path)}:${createHash('sha256').update(bytes).digest('hex')}`,
        );
      }
    }
  }
  await visit(projectDir);
  return createHash('sha256').update(files.sort().join('\n'), 'utf8').digest('hex');
}

function productionFailureIsHarness(result: RunnerCallResult): boolean {
  const code = result.error?.code;
  return (
    code === 'prompt-transport-error' || code === 'argument-conflict' || code === 'callback-failure'
  );
}

async function invokeCandidate(
  candidate: CandidateValue,
  role: CliConformanceRole,
  projectDir: string,
  environment: NodeJS.ProcessEnv,
  executable: CliExecutableIdentity,
): Promise<RunnerCallResult> {
  const contract = candidate.rawContract;
  const adapter = candidate.adapter;
  if (adapter.promptTransport.kind !== contract.promptTransport) {
    throwConformance('harness-failure', 'CLI adapter prompt transport differs from raw contract');
  }
  let args = adapterArgs(adapter, projectDir);
  if (contract.promptTransport === 'file' && !args.some((arg) => arg === CLI_PROMPT_SENTINEL)) {
    args = [...args, CLI_PROMPT_SENTINEL];
  }
  const processInvocation = {
    executable,
    args,
    promptTransport: adapter.promptTransport,
    environment: toCliEnvironment({ ...environment, ...adapter.environment }),
    cwd: projectDir,
    timeoutMs: INVOCATION_TIMEOUT_MS,
    signal: undefined,
  };
  const callContext: RunnerCallContext = {
    callId: `cli-conformance-${contract.id}`,
    role,
    backendKind: 'cli',
    runnerName: contract.id,
  };
  const result = await invokeProcessCli(processAdapter(adapter, contract), {
    invocation: processInvocation,
    prompt: CONFORMANCE_PROMPT,
    callContext,
  });
  return RunnerCallResultSchema.parse(result);
}

export async function runProductionCliConformance(
  options: ProductionCliConformanceOptions,
): Promise<CliConformanceOutcome> {
  let rawCapture: RawCapture;
  try {
    rawCapture = await readRawRecord(options.recordPath);
  } catch (cause) {
    return {
      exitCode: CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
      verdict: 'OMIT',
      role: options.role,
      reason: safeReason(cause),
    };
  }
  let candidate: CandidateValue;
  try {
    candidate = selectCandidate(
      await loadCandidateModule(options.modulePath),
      rawCapture,
      options.role,
    );
  } catch (cause) {
    return {
      exitCode: CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
      verdict: 'OMIT',
      candidateId: rawCapture.candidateId,
      role: options.role,
      reason: safeReason(cause),
    };
  }
  const project = await createProject(options.projectDir);
  try {
    const environment = await sandboxEnvironment(
      project.path,
      candidate.rawContract,
      options.environment,
    );
    const credentials = credentialsForContract(candidate.rawContract, environment);
    if (!hasRequiredCredential(candidate.rawContract, environment)) {
      const production = captureFor(
        candidate.rawContract,
        '',
        'required credential is unavailable',
        credentials,
      );
      await writeProductionRecord(options.recordPath, rawCapture, production, 'OMIT');
      return {
        exitCode: CLI_CONFORMANCE_EXIT_CODES.OMIT,
        verdict: 'OMIT',
        candidateId: candidate.id,
        role: options.role,
        reason: 'required CLI credential is unavailable',
      };
    }
    let executable: CliExecutableIdentity;
    try {
      executable = await (options.resolveExecutable ?? resolveCliExecutable)(
        candidate.rawContract.command,
        project.path,
      );
    } catch {
      const production = captureFor(
        candidate.rawContract,
        '',
        'CLI executable is unavailable',
        credentials,
      );
      await writeProductionRecord(options.recordPath, rawCapture, production, 'OMIT');
      return {
        exitCode: CLI_CONFORMANCE_EXIT_CODES.OMIT,
        verdict: 'OMIT',
        candidateId: candidate.id,
        role: options.role,
        reason: 'CLI executable is unavailable',
      };
    }
    const before = await projectFingerprint(project.path);
    let result: RunnerCallResult;
    try {
      result = await invokeCandidate(
        candidate,
        options.role,
        project.path,
        environment,
        executable,
      );
    } catch (cause) {
      const reason = safeReason(cause);
      const production = captureFor(candidate.rawContract, '', reason, credentials);
      await writeProductionRecord(options.recordPath, rawCapture, production, 'OMIT');
      return {
        exitCode: CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
        verdict: 'OMIT',
        candidateId: candidate.id,
        role: options.role,
        reason,
      };
    }
    const after = await projectFingerprint(project.path);
    const output = JSON.stringify(
      {
        candidateId: candidate.id,
        role: options.role,
        status: result.status,
        textBytes: Buffer.byteLength(result.text, 'utf8'),
        directChange: before !== after,
        terminal: result.status === 'completed',
      },
      null,
      2,
    );
    if (productionFailureIsHarness(result)) {
      const production = captureFor(
        candidate.rawContract,
        output,
        result.error?.message ?? '',
        credentials,
      );
      await writeProductionRecord(options.recordPath, rawCapture, production, 'OMIT');
      return {
        exitCode: CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
        verdict: 'OMIT',
        candidateId: candidate.id,
        role: options.role,
        reason: 'CLI adapter rejected the conformance invocation',
      };
    }
    if (result.status !== 'completed' || (options.role === 'implementer' && before === after)) {
      const reason =
        options.role === 'implementer' && before === after
          ? 'implementer produced no staged-project change'
          : `CLI production result was ${result.status}`;
      const production = captureFor(candidate.rawContract, output, reason, credentials);
      await writeProductionRecord(options.recordPath, rawCapture, production, 'OMIT');
      return {
        exitCode: CLI_CONFORMANCE_EXIT_CODES.OMIT,
        verdict: 'OMIT',
        candidateId: candidate.id,
        role: options.role,
        reason,
      };
    }
    const production = captureFor(candidate.rawContract, output, '', credentials);
    await writeProductionRecord(options.recordPath, rawCapture, production, 'PASS');
    return {
      exitCode: CLI_CONFORMANCE_EXIT_CODES.PASS,
      verdict: 'PASS',
      candidateId: candidate.id,
      role: options.role,
    };
  } finally {
    await project.cleanup();
  }
}
