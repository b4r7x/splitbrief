import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CliExecutableIdentity } from '../../../../core/discovery/detection/executable.js';
import { INTERNAL_SKIP_DIRS } from '../../../../core/paths.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import type { RunnerCallResult } from '../../../calls/types.js';
import { readRawCaptureRecord, writeEvidenceFile } from '../../../providers/candidate/harness.js';
import { resolveCliExecutable } from '../../cli-executable/resolve.js';
import { candidateEvidenceWithCliCapture } from '../candidate-contract.js';
import {
  type CandidateValue,
  selectCandidate,
  loadCandidateModule,
  invokeCandidate,
} from './candidate.js';
import {
  type RawCapture,
  type CliConformanceVerdict,
  type ProductionCliConformanceOptions,
  type CliConformanceOutcome,
  captureFor,
  CLI_CONFORMANCE_EXIT_CODES,
  safeReason,
  createProject,
  sandboxEnvironment,
  credentialsForContract,
  hasRequiredCredential,
} from './harness.js';

const PROJECT_FINGERPRINT_SKIP_DIRS = new Set([...INTERNAL_SKIP_DIRS, '.nuke']);

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
        files.push(`${relative(projectDir, path)}:${sha256Hex(bytes)}`);
      }
    }
  }
  await visit(projectDir);
  return sha256Hex(files.sort().join('\n'));
}

function productionFailureIsHarness(result: RunnerCallResult): boolean {
  const code = result.error?.code;
  return (
    code === 'prompt-transport-error' || code === 'argument-conflict' || code === 'callback-failure'
  );
}

async function recordOmit(input: {
  options: ProductionCliConformanceOptions;
  rawCapture: RawCapture;
  candidate: CandidateValue;
  credentials: readonly string[];
  stdout: string;
  stderr: string;
  reason: string;
  exitCode: CliConformanceOutcome['exitCode'];
}): Promise<CliConformanceOutcome> {
  await writeProductionRecord({
    recordPath: input.options.recordPath,
    rawCapture: input.rawCapture,
    productionConformance: captureFor({
      contract: input.candidate.rawContract,
      stdout: input.stdout,
      stderr: input.stderr,
      credentials: input.credentials,
    }),
    verdict: 'OMIT',
  });
  return {
    exitCode: input.exitCode,
    verdict: 'OMIT',
    candidateId: input.candidate.id,
    role: input.options.role,
    reason: input.reason,
  };
}

export async function runProductionCliConformance(
  options: ProductionCliConformanceOptions,
): Promise<CliConformanceOutcome> {
  let rawCapture: RawCapture;
  try {
    rawCapture = await readRawCaptureRecord(options.recordPath, {
      label: 'CLI',
      standalone: true,
    });
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
      return recordOmit({
        options,
        rawCapture,
        candidate,
        credentials,
        stdout: '',
        stderr: 'required credential is unavailable',
        reason: 'required CLI credential is unavailable',
        exitCode: CLI_CONFORMANCE_EXIT_CODES.OMIT,
      });
    }
    let executable: CliExecutableIdentity;
    try {
      executable = await (options.resolveExecutable ?? resolveCliExecutable)({
        command: candidate.rawContract.command,
        projectDir: project.path,
      });
    } catch {
      return recordOmit({
        options,
        rawCapture,
        candidate,
        credentials,
        stdout: '',
        stderr: 'CLI executable is unavailable',
        reason: 'CLI executable is unavailable',
        exitCode: CLI_CONFORMANCE_EXIT_CODES.OMIT,
      });
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
      return recordOmit({
        options,
        rawCapture,
        candidate,
        credentials,
        stdout: '',
        stderr: reason,
        reason,
        exitCode: CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
      });
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
      return recordOmit({
        options,
        rawCapture,
        candidate,
        credentials,
        stdout: output,
        stderr: result.error?.message ?? '',
        reason: 'CLI adapter rejected the conformance invocation',
        exitCode: CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
      });
    }
    if (result.status !== 'completed' || (options.role === 'implementer' && before === after)) {
      const reason =
        options.role === 'implementer' && before === after
          ? 'implementer produced no staged-project change'
          : `CLI production result was ${result.status}`;
      return recordOmit({
        options,
        rawCapture,
        candidate,
        credentials,
        stdout: output,
        stderr: reason,
        reason,
        exitCode: CLI_CONFORMANCE_EXIT_CODES.OMIT,
      });
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
