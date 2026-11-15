import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { isRecord } from '../../../../utils/type-guards.js';
import { CONFORMANCE_PROMPT, contractSha256 } from '../../../providers/candidate/contract.js';
import { throwConformance } from '../../../providers/candidate/harness.js';
import {
  parseCliConformanceCandidates,
  type RawCliCandidateContract,
  type UnregisteredCliAdapter,
  type UnregisteredCliCandidate,
} from '../candidate-contract.js';
import type { CliProcessAdapter } from '../contract.js';
import { type RawCapture, type CliConformanceRole, INVOCATION_TIMEOUT_MS } from './harness.js';
import type { CliExecutableIdentity } from '../../../../core/discovery/detection/executable.js';
import { createRunnerCallId } from '../../../calls/id.js';
import { RunnerCallResultSchema } from '../../../calls/schema.js';
import type { RunnerCallResult, RunnerCallContext } from '../../../calls/types.js';
import { toCliEnvironment } from '../../invoke-cli-adapter.js';
import { invokeProcessCli } from '../process-invoke/invoke.js';

export type CandidateValue = z.infer<typeof UnregisteredCliCandidate>;

export async function loadCandidateModule(modulePath: string): Promise<readonly CandidateValue[]> {
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

export function selectCandidate(
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
          model: undefined,
          projectDir,
          configuredArgs: [],
          sessionId: null,
          effort: undefined,
        })
      : adapter.buildArgs({
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
    descriptor: {
      id: contract.id,
      displayName: contract.id,
      auth: { channels: [{ env: [...contract.auth.env] }] },
    },
    promptTransport: adapter.promptTransport,
    encodePrompt: adapter.encodePrompt,
    validateArgs: adapter.validateArgs,
    outputContract: adapter.outputContract,
    parse: adapter.parse,
    terminal: adapter.terminal,
  };
}

export async function invokeCandidate(opts: {
  candidate: CandidateValue;
  role: CliConformanceRole;
  projectDir: string;
  environment: NodeJS.ProcessEnv;
  executable: CliExecutableIdentity;
}): Promise<RunnerCallResult> {
  const contract = opts.candidate.rawContract;
  const adapter = opts.candidate.adapter;
  const args = adapterArgs(adapter, opts.projectDir);
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
    callId: createRunnerCallId(`cli-conformance-${contract.id}`),
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
