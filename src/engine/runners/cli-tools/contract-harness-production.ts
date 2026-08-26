import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { INTERNAL_SKIP_DIRS } from '../../../core/paths.js';
import { RunnerCallResultSchema } from '../../calls/schema.js';
import type { RunnerCallContext, RunnerCallResult } from '../../calls/types.js';
import { resolveCliExecutable } from '../resolve-cli-executable.js';
import { toCliEnvironment } from '../invoke-cli-adapter.js';
import { invokeProcessCli } from './process-invoke.js';
import type { CliProcessAdapter } from './contract.js';
import {
  CLI_PROMPT_SENTINEL,
  type RawCliCandidateContract,
  type UnregisteredCliAdapter,
  type UnregisteredCliCandidate,
  candidateEvidenceWithCliCapture,
  parseCliConformanceCandidates,
} from './candidate-contract.js';
import {
  CandidateEvidence,
  CONFORMANCE_PROMPT,
  contractSha256,
} from '../../providers/candidate-contract.js';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  INVOCATION_TIMEOUT_MS,
  captureFor,
  createProject,
  credentialsForContract,
  hasRequiredCredential,
  safeReason,
  sandboxEnvironment,
  throwConformance,
  writeEvidenceFile,
  type CliConformanceOutcome,
  type CliConformanceRole,
  type CliConformanceVerdict,
  type ProductionCliConformanceOptions,
  type RawCapture,
} from './contract-harness.js';
import { isRecord } from '../../../utils/type-guards.js';

const PROJECT_FINGERPRINT_SKIP_DIRS = new Set([...INTERNAL_SKIP_DIRS, '.nuke']);

type CandidateValue = z.infer<typeof UnregisteredCliCandidate>;

async function writeProductionRecord(opts: {
  recordPath: string;
  rawCapture: RawCapture;
  productionConformance: RawCapture | null;
  verdict: CliConformanceVerdict;
}): Promise<void> {
  const evidence = candidateEvidenceWithCliCapture(
    opts.rawCapture,
    opts.productionConformance,
    opts.verdict,
  );
  await writeEvidenceFile(opts.recordPath, JSON.stringify(evidence, null, 2));
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

async function invokeCandidate(opts: {
  candidate: CandidateValue;
  role: CliConformanceRole;
  projectDir: string;
  environment: NodeJS.ProcessEnv;
  executable: CliExecutableIdentity;
}): Promise<RunnerCallResult> {
  const contract = opts.candidate.rawContract;
  const adapter = opts.candidate.adapter;
  if (adapter.promptTransport.kind !== contract.promptTransport) {
    throwConformance('harness-failure', 'CLI adapter prompt transport differs from raw contract');
  }
  let args = adapterArgs(adapter, opts.projectDir);
  if (contract.promptTransport === 'file' && !args.some((arg) => arg === CLI_PROMPT_SENTINEL)) {
    args = [...args, CLI_PROMPT_SENTINEL];
  }
  const processInvocation = {
    executable: opts.executable,
    args,
    promptTransport: adapter.promptTransport,
    environment: toCliEnvironment({ ...opts.environment, ...adapter.environment }),
    cwd: opts.projectDir,
    timeoutMs: INVOCATION_TIMEOUT_MS,
    signal: undefined,
  };
  const callContext: RunnerCallContext = {
    callId: `cli-conformance-${contract.id}`,
    role: opts.role,
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
      const production = captureFor({
        contract: candidate.rawContract,
        stdout: '',
        stderr: 'required credential is unavailable',
        credentials,
      });
      await writeProductionRecord({
        recordPath: options.recordPath,
        rawCapture,
        productionConformance: production,
        verdict: 'OMIT',
      });
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
      executable = await (options.resolveExecutable ?? resolveCliExecutable)({
        command: candidate.rawContract.command,
        projectDir: project.path,
      });
    } catch {
      const production = captureFor({
        contract: candidate.rawContract,
        stdout: '',
        stderr: 'CLI executable is unavailable',
        credentials,
      });
      await writeProductionRecord({
        recordPath: options.recordPath,
        rawCapture,
        productionConformance: production,
        verdict: 'OMIT',
      });
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
      result = await invokeCandidate({
        candidate,
        role: options.role,
        projectDir: project.path,
        environment,
        executable,
      });
    } catch (cause) {
      const reason = safeReason(cause);
      const production = captureFor({
        contract: candidate.rawContract,
        stdout: '',
        stderr: reason,
        credentials,
      });
      await writeProductionRecord({
        recordPath: options.recordPath,
        rawCapture,
        productionConformance: production,
        verdict: 'OMIT',
      });
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
      const production = captureFor({
        contract: candidate.rawContract,
        stdout: output,
        stderr: result.error?.message ?? '',
        credentials,
      });
      await writeProductionRecord({
        recordPath: options.recordPath,
        rawCapture,
        productionConformance: production,
        verdict: 'OMIT',
      });
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
      const production = captureFor({
        contract: candidate.rawContract,
        stdout: output,
        stderr: reason,
        credentials,
      });
      await writeProductionRecord({
        recordPath: options.recordPath,
        rawCapture,
        productionConformance: production,
        verdict: 'OMIT',
      });
      return {
        exitCode: CLI_CONFORMANCE_EXIT_CODES.OMIT,
        verdict: 'OMIT',
        candidateId: candidate.id,
        role: options.role,
        reason,
      };
    }
    const production = captureFor({
      contract: candidate.rawContract,
      stdout: output,
      stderr: '',
      credentials,
    });
    await writeProductionRecord({
      recordPath: options.recordPath,
      rawCapture,
      productionConformance: production,
      verdict: 'PASS',
    });
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
