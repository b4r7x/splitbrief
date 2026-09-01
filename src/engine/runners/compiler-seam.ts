import { randomUUID } from 'node:crypto';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import { getWorkflowMode } from '../../core/config/accessors/values.js';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import type { Config } from '../../core/schemas/config.js';
import { TASK_BRIEF_COMPILER_POLICY } from '../../core/schemas/task-compilation.js';
import type {
  PlannerArtifactTransport,
  TaskCompilationCallEnvelope,
  TaskCompilationOperationEnvelope,
  TaskCompilationOperationId,
} from '../../core/schemas/task-compilation.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { sha256Hex } from '../../utils/sha256.js';
import { createTaskDispatchClaimPort, createTaskDispatchLedger } from '../calls/dispatch-ledger.js';
import { loadRememberedCliRuntime } from '../detection/cache.js';
import {
  installCompilerRefusal,
  installCompilerSeam,
  readPlannerCompilerDispatch,
  type CompilerBatchDispatch,
  type CompilerRefusal,
  type CompilerSeam,
} from '../planners/base.js';
import type { Planner } from '../planners/types.js';
import { isDeclaredCliProbeContract } from './cli-tools/contract.js';
import { probeDeclaredCliReadinessEvidence } from './cli-tools/readiness-probe.js';
import { admitCliCompilerRuntime, lookupCliReadinessProbe } from './cli-tools/registry.js';
import { admitCompilerCapability, COMPILER_SUPPORT_TABLE } from './compiler-capability.js';
import type { CompilerCapabilityReceipt } from './compiler-capability.js';
import { deriveCompilerClaim } from './compiler-claim.js';
import { bindCompilerRuntimeEvidence } from './compiler-runtime-evidence.js';
import { fingerprintsEqual } from './resolve-cli-executable.js';
import type { CliStartGate } from './start-gate.js';
import type { PreparedPlannerInvocation } from './types.js';

const COMPILER_REFUSAL_NO_EVIDENCE: CompilerRefusal = {
  code: 'task_compiler_capability_unsupported',
  message:
    'The run carries no verified compiler conformance evidence; standard/speckit planning is refused (REQ-016) and no Task dispatch happens.',
};

const COMPILER_REFUSAL_UNPREPARED: CompilerRefusal = {
  code: 'task_compiler_capability_unsupported',
  message:
    'The admitted compiler claim cannot be prepared for this backend; standard/speckit planning is refused (REQ-016) with zero dispatch.',
};

type RuntimeVersionEvidence =
  | Readonly<{ kind: 'known'; version: string }>
  | Readonly<{ kind: 'unavailable'; reason: string }>;

/**
 * A remembered version is admissible only for the exact binary this run already
 * admitted: the readiness record was probed against whatever was first on PATH
 * then, and a version bound to a different executable would reach the drift
 * warning and the runtime-conformance gate as `tested` evidence.
 */
async function rememberedCliVersion(
  input: Readonly<{ projectDir: string; tool: CliToolId; trustedCli: CliStartGate }>,
): Promise<string | null> {
  const remembered = await loadRememberedCliRuntime({
    projectDir: input.projectDir,
    tool: input.tool,
  });
  if (remembered === null) return null;
  return fingerprintsEqual(remembered.fingerprint, input.trustedCli.executable.fingerprint)
    ? remembered.installedVersion
    : null;
}

async function cliRuntimeVersionEvidence(
  input: Readonly<{
    projectDir?: string | undefined;
    tool: CliToolId;
    trustedCli: CliStartGate;
  }>,
): Promise<RuntimeVersionEvidence> {
  const projectDir = input.projectDir;
  if (projectDir !== undefined) {
    const remembered = await rememberedCliVersion({
      projectDir,
      tool: input.tool,
      trustedCli: input.trustedCli,
    });
    if (remembered !== null) return { kind: 'known', version: remembered };
  }

  const probeContract = lookupCliReadinessProbe({ tool: input.tool, role: 'planner' });
  if (!isDeclaredCliProbeContract(probeContract)) {
    return {
      kind: 'unavailable',
      reason: `The ${input.tool} adapter declares no runtime version probe`,
    };
  }
  try {
    const probed = await probeDeclaredCliReadinessEvidence({
      tool: input.tool,
      executable: input.trustedCli.executable,
      probe: probeContract.declared,
    });
    return probed.version.kind === 'success'
      ? { kind: 'known', version: probed.version.value }
      : {
          kind: 'unavailable',
          reason: `The ${input.tool} runtime version probe returned ${probed.version.kind}`,
        };
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: `The ${input.tool} runtime version probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The one production seam installer (REQ-016, REQ-046): quick planners never
 * carry a compiler; standard/speckit planners get the deterministic
 * compiler when capability admission admits the run's claim, and a typed
 * zero-dispatch refusal otherwise — never the legacy single-call prompt.
 *
 * The claim is derived here, from the support row plus two host observations:
 * the probed (or remembered) runtime version and the launcher profile. Those
 * two arms, and an unsupported row, are what `admitCompilerCapability` refuses
 * on for a derived claim; its transport, terminal-contract, envelope-version
 * and fixture-date arms compare the row against itself and hold by
 * construction.
 */
export async function installRunCompiler(
  input: Readonly<{
    planner: Planner;
    config: Config;
    projectDir: string | undefined;
    trustedCli: CliStartGate | undefined;
  }>,
): Promise<void> {
  const { planner, config, trustedCli } = input;
  const mode = getWorkflowMode(config);
  if (mode === 'quick') return;

  const runner = config.planner;
  const evidence =
    runner.kind === 'cli' && trustedCli !== undefined
      ? await cliRuntimeVersionEvidence({
          projectDir: input.projectDir,
          tool: runner.tool,
          trustedCli,
        })
      : null;

  const derivation = await deriveCompilerClaim({
    config,
    ...(evidence?.kind === 'known' && { detectedVersion: evidence.version }),
  });
  if (derivation.kind === 'refused') {
    installCompilerRefusal(planner, {
      code: 'task_compiler_capability_unsupported',
      message:
        evidence?.kind === 'unavailable'
          ? `${derivation.failure.message} ${evidence.reason}.`
          : derivation.failure.message,
    });
    return;
  }
  const dispatch = readPlannerCompilerDispatch(planner);
  if (dispatch === null) {
    installCompilerRefusal(planner, COMPILER_REFUSAL_NO_EVIDENCE);
    return;
  }

  const admission = admitCompilerCapability(derivation.claim);
  if (admission.kind === 'refused') {
    installCompilerRefusal(planner, {
      code: 'task_compiler_capability_unsupported',
      message: admission.failure.message,
    });
    return;
  }
  const seam = await buildCompilerSeam({
    config,
    trustedCli,
    receipt: admission.receipt,
    operationId: derivation.operationId,
    dispatch,
  });
  if (seam === null) {
    installCompilerRefusal(planner, COMPILER_REFUSAL_UNPREPARED);
    return;
  }
  installCompilerSeam(planner, seam);
}

async function buildCompilerSeam(
  input: Readonly<{
    config: Config;
    trustedCli: CliStartGate | undefined;
    receipt: CompilerCapabilityReceipt;
    operationId: TaskCompilationOperationId;
    dispatch: CompilerBatchDispatch;
  }>,
): Promise<CompilerSeam | null> {
  const runner = input.config.planner;
  const receipt = input.receipt;
  let executablePath: string | undefined;
  let transports: readonly PlannerArtifactTransport['kind'][];

  if (runner.kind === 'cli') {
    if (input.trustedCli === undefined) return null;
    const parsedExecutable = CliExecutableReceiptSchema.safeParse(input.trustedCli.executable);
    if (!parsedExecutable.success) return null;
    const runtime = bindCompilerRuntimeEvidence({
      backend: receipt.backend,
      executable: parsedExecutable.data,
      version: receipt.runtimeVersion,
    });
    if (runtime.kind !== 'bound') return null;
    const registry = admitCliCompilerRuntime({ tool: runner.tool, runtime: runtime.evidence });
    if (registry.kind !== 'admitted') return null;
    executablePath = runtime.evidence.executable.path;
    transports = runtime.evidence.transports;
  } else {
    const row = Object.hasOwn(COMPILER_SUPPORT_TABLE, receipt.backend)
      ? COMPILER_SUPPORT_TABLE[receipt.backend]
      : undefined;
    if (row === undefined || row.state === 'unsupported') return null;
    transports = row.transports;
  }

  const invocation = assembleCompilerInvocation({ receipt, executablePath, transports });
  if (invocation === null) return null;
  const ledger = createTaskDispatchLedger({
    operation: compilerOperationEnvelope(input.operationId),
    operationId: input.operationId,
    claimPort: createTaskDispatchClaimPort(),
  });
  return { invocation, ledger, dispatch: input.dispatch, receipt };
}

function compilerOperationEnvelope(
  operationId: TaskCompilationOperationId,
): TaskCompilationOperationEnvelope {
  const limit = TASK_BRIEF_COMPILER_POLICY.maxDispatches;
  return {
    version: 1,
    dispatchLimit: limit,
    callCount: 0,
    totalPromptBytes: 0,
    totalInputTokensUpperBound: 0,
    totalOutputTokensUpperBound: 0,
    totalNormalizedOutputBytes: 0,
    totalDeclaredArtifactBytes: 0,
    callsDigest: sha256Hex(
      canonicalJSON({ domain: 'splitbrief-planner-operation-v1', operationId }),
    ),
  };
}

function compilerEnvelope(): TaskCompilationCallEnvelope {
  const policy = TASK_BRIEF_COMPILER_POLICY;
  return {
    version: 1,
    promptBytes: policy.maxPromptBytes,
    inputTokensUpperBound: policy.maxPromptBytes,
    requestedOutputTokens: policy.requestedOutputTokens,
    outputTokensUpperBound: policy.maxNormalizedOutputBytes,
    maxNormalizedOutputBytes: policy.maxNormalizedOutputBytes,
    maxDeclaredArtifactBytes: policy.maxDeclaredArtifactBytes,
    maxRawProtocolBytes: policy.maxRawProtocolBytes,
    maxStderrBytes: policy.maxStderrBytes,
    deadlineMs: policy.deadlineMs,
    idleTimeoutMs: policy.idleTimeoutMs,
  };
}

/**
 * The prepared call records what the admitted receipt certifies. Nothing here
 * is launched: the batch dispatch reaches the planner adapter, which prepares
 * its own argument vector, working directory and credentials, and each batch
 * carries its own session scope — so no argv, cwd, credential copy, containment
 * lease or session scope is recorded.
 */
function assembleCompilerInvocation(
  input: Readonly<{
    receipt: CompilerCapabilityReceipt;
    executablePath: string | undefined;
    transports: readonly PlannerArtifactTransport['kind'][];
  }>,
): PreparedPlannerInvocation | null {
  if (!input.transports.includes(input.receipt.transport)) return null;
  const protocolDigest = sha256Hex(
    canonicalJSON({
      domain: 'splitbrief-compiler-protocol-v1',
      backend: input.receipt.backend,
      terminalContract: input.receipt.terminalContract,
      envelopeVersion: input.receipt.envelopeVersion,
    }),
  );
  const transport: PlannerArtifactTransport =
    input.receipt.transport === 'declared-file'
      ? { kind: 'declared-file', lease: { leaseId: randomUUID() } }
      : { kind: 'stdout-final' };
  return {
    runtime: {
      ...(input.executablePath !== undefined && { executablePath: input.executablePath }),
      version: input.receipt.version,
      runtimeDigest: input.receipt.capabilityDigest,
      protocolDigest,
    },
    role: 'planner-read-only',
    transport,
    terminalContract: input.receipt.terminalContract,
    envelope: compilerEnvelope(),
    capabilityDigest: input.receipt.capabilityDigest,
  };
}
