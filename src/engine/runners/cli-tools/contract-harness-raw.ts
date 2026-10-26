import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { resolveCliExecutable } from '../resolve-cli-executable.js';
import { RawCliCandidateContract, replaceProjectDirSentinel } from './candidate-contract.js';
import { CONFORMANCE_PROMPT } from '../../providers/candidate-contract.js';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  INVOCATION_TIMEOUT_MS,
  MAX_PROCESS_OUTPUT_BYTES,
  captureFor,
  createProject,
  credentialsForContract,
  hasConformanceCode,
  hasRequiredCredential,
  processRunnerOf,
  safeReason,
  sandboxEnvironment,
  throwConformance,
  writeEvidenceFile,
  type CliConformanceOutcome,
  type CliProcessResult,
  type CliProcessRunner,
  type RawCapture,
  type RawCliConformanceOptions,
} from './contract-harness.js';

const PROBE_TIMEOUT_MS = 5_000;

async function writeRawRecord(recordPath: string, rawCapture: RawCapture): Promise<void> {
  await writeEvidenceFile(recordPath, JSON.stringify({ rawCapture }, null, 2));
}

function expectedTerminalSeen(
  contract: RawCliCandidateContract,
  result: CliProcessResult,
): boolean {
  if (contract.expectedRawTerminal === 'process-exit') return result.exitCode === 0;
  return `${result.stdout}\n${result.stderr}`.includes(contract.expectedRawTerminal);
}

async function runRawInvocation(opts: {
  contract: RawCliCandidateContract;
  executable: CliExecutableIdentity;
  projectDir: string;
  environment: NodeJS.ProcessEnv;
  processRunner: CliProcessRunner;
}): Promise<{
  readonly result: CliProcessResult;
  readonly output: string;
  readonly errorText: string;
}> {
  const result = await opts.processRunner({
    command: opts.executable.path,
    args: replaceProjectDirSentinel(opts.contract.rawInvocation, opts.projectDir),
    cwd: opts.projectDir,
    env: opts.environment,
    stdin: CONFORMANCE_PROMPT,
    timeoutMs: INVOCATION_TIMEOUT_MS,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
  });
  return {
    result,
    output: `${result.stdout}\n${result.stderr}`,
    errorText: result.timedOut ? 'CLI invocation timed out' : '',
  };
}

async function runRawProbes(opts: {
  contract: RawCliCandidateContract;
  executable: CliExecutableIdentity;
  projectDir: string;
  environment: NodeJS.ProcessEnv;
  processRunner: CliProcessRunner;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const version = await opts.processRunner({
    command: opts.executable.path,
    args: [...opts.contract.versionArgs],
    cwd: opts.projectDir,
    env: opts.environment,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
  });
  const outputs = [`version exit=${version.exitCode}\n${version.stdout}`];
  const errors = [version.stderr];
  if (version.timedOut || version.exitCode !== 0 || version.outputExceeded) {
    throwConformance('credentialed-omit', 'CLI version probe did not complete successfully');
  }
  if (opts.contract.auth.kind !== 'none' && opts.contract.auth.kind !== 'env-only') {
    const auth = await opts.processRunner({
      command: opts.executable.path,
      args: ['auth'],
      cwd: opts.projectDir,
      env: opts.environment,
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
      const capture = captureFor({
        contract,
        stdout: '',
        stderr: 'missing credential',
        credentials,
      });
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
      executable = await resolveExecutable({ command: contract.command, projectDir: project.path });
    } catch (cause) {
      const capture = captureFor({
        contract,
        stdout: '',
        stderr: safeReason(cause),
        credentials,
      });
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
      probeOutput = await runRawProbes({
        contract,
        executable,
        projectDir: project.path,
        environment,
        processRunner,
      });
      invocation = await runRawInvocation({
        contract,
        executable,
        projectDir: project.path,
        environment,
        processRunner,
      });
    } catch (cause) {
      const reason = safeReason(cause);
      const capture = captureFor({ contract, stdout: '', stderr: reason, credentials });
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
    const capture = captureFor({ contract, stdout, stderr, credentials });
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
