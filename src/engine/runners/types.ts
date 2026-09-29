import type { TieredApprovalRequest, TieredApprovalResponse } from '../../core/approval/types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { ChangedFilesSnapshot } from '../../core/schemas/workflow.js';
import { MAX_DECLARED_ARTIFACT_BYTES } from '../../core/schemas/planner-artifact.js';
import type {
  RunnerCallTextChannel,
  RUNNER_CALL_USAGE_SEMANTICS,
  RUNNER_CALL_WARNING_SEVERITIES,
  RUNNER_CALL_WARNING_SURFACES,
} from '../../core/runner-call-contract.js';
import type { RunnerCallTextSemantics } from '../calls/types.js';
import type {
  PlannerArtifactTransport,
  PlannerArtifactAttemptId,
  PlannerArtifactBatchId,
  PlannerArtifactProgramId,
  PlannerArtifactSemanticId,
} from '../../core/schemas/planner-artifact.js';

export interface ToolUseInfo {
  id?: string | undefined;
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
}

export interface ToolUseDeltaInfo {
  id?: string | undefined;
  name?: string | undefined;
  inputDelta: string;
}

export interface ParsedWarningInfo {
  code: string;
  message: string;
  severity?: (typeof RUNNER_CALL_WARNING_SEVERITIES)[number] | undefined;
  source?: string | undefined;
  surface?: (typeof RUNNER_CALL_WARNING_SURFACES)[number] | undefined;
  parser?: string | undefined;
  upstreamType?: string | undefined;
  channel?: RunnerCallTextChannel | 'stderr' | 'tool' | undefined;
  fingerprint?: string | undefined;
  rawRef?: string | undefined;
}

export type ParsedTextChannel = RunnerCallTextChannel;
export type ParsedTextSemantics = RunnerCallTextSemantics;
export type ParsedUsageSemantics = (typeof RUNNER_CALL_USAGE_SEMANTICS)[number];

export type ParsedLine =
  | {
      text: string;
      channel?: ParsedTextChannel | undefined;
      usage?: TokenDelta | undefined;
      usageSemantics?: ParsedUsageSemantics | undefined;
      isResult?: boolean | undefined;
      isError?: boolean | undefined;
      sessionId?: string | undefined;
      toolUse?: ToolUseInfo[] | undefined;
      toolUseStart?: ToolUseInfo[] | undefined;
      toolUseDelta?: ToolUseDeltaInfo[] | undefined;
      toolUseDone?: ToolUseInfo[] | undefined;
      warning?: ParsedWarningInfo[] | undefined;
      isHeartbeat?: boolean | undefined;
    }
  | {
      text?: undefined;
      channel?: undefined;
      usage: TokenDelta;
      usageSemantics?: ParsedUsageSemantics | undefined;
      isResult?: boolean | undefined;
      isError?: boolean | undefined;
      sessionId?: string | undefined;
      toolUse?: ToolUseInfo[] | undefined;
      toolUseStart?: ToolUseInfo[] | undefined;
      toolUseDelta?: ToolUseDeltaInfo[] | undefined;
      toolUseDone?: ToolUseInfo[] | undefined;
      warning?: ParsedWarningInfo[] | undefined;
      isHeartbeat?: boolean | undefined;
    }
  | {
      text?: undefined;
      channel?: undefined;
      usage?: undefined;
      usageSemantics?: undefined;
      isResult?: undefined;
      isError?: boolean | undefined;
      sessionId?: string | undefined;
      toolUse?: ToolUseInfo[] | undefined;
      toolUseStart?: ToolUseInfo[] | undefined;
      toolUseDelta?: ToolUseDeltaInfo[] | undefined;
      toolUseDone?: ToolUseInfo[] | undefined;
      warning?: ParsedWarningInfo[] | undefined;
      isHeartbeat?: boolean | undefined;
    };

/**
 * Compatibility return shape for legacy runner adapters.
 * New typed call records should use `RunnerCallResult` from `src/engine/calls/types.ts`.
 */
export interface InvokeResult {
  text: string;
  usage: TokenDelta | null;
}

export interface RunnerRuntime {
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string | null>;
}

export type CustomRunnerStage = Readonly<{
  projectDir: string;
  snapshot: ChangedFilesSnapshot;
  cleanup: () => void;
}>;

export type CustomRunnerAdmissionPolicy = Readonly<{
  interaction: 'interactive' | 'headless';
  allowRepoRunners: boolean;
  stateDir?: string | undefined;
  onTieredApproval?:
    | ((request: TieredApprovalRequest) => Promise<TieredApprovalResponse>)
    | undefined;
}>;

export const DECLARED_PLANNER_ARTIFACT_PATH_ENV = 'SPLITBRIEF_DECLARED_ARTIFACT_PATH';
export const PLANNER_ARTIFACT_MAX_BYTES = MAX_DECLARED_ARTIFACT_BYTES;

/**
 * Immutable canonical text for the direct-planner artifact approval surface.
 * `label` is display-only: consumers must never interpret or reopen it as a
 * filesystem path.
 */
export type ArtifactApprovalReview = Readonly<{
  label: string;
  text: string;
}>;

export type ApprovalReviewInput = string | ArtifactApprovalReview;

/**
 * Canonical provenance supplied by the host before a declared-file planner
 * invocation.  Every field is required so a runtime adapter cannot silently
 * fall back to an unscoped artifact path or receipt.
 */
export type DeclaredArtifactProvenance = Readonly<{
  semanticId: PlannerArtifactSemanticId;
  programId: PlannerArtifactProgramId | null;
  batchId: PlannerArtifactBatchId | null;
  attemptId: PlannerArtifactAttemptId;
  transport: Extract<PlannerArtifactTransport, { kind: 'declared-file' }>;
  maxBytes: number;
  relativePath: string;
}>;

export type DeclaredArtifactReceipt = Readonly<{
  semanticId: PlannerArtifactSemanticId;
  programId: PlannerArtifactProgramId | null;
  batchId: PlannerArtifactBatchId | null;
  attemptId: PlannerArtifactAttemptId;
  leaseId: string;
  relativePath: string;
  inodeIdentity: string;
  ancestryDigest: string;
  sha256: string;
  byteLength: number;
  leaseReceiptDigest: string;
}>;

export type DeclaredArtifactRead = Readonly<{
  text: string;
  receipt: DeclaredArtifactReceipt;
}>;

export type BeginDeclaredArtifactReviewInput = Readonly<{
  stagedProjectDir: string;
  callId: string;
  declaredRedactionValues: readonly string[];
  provenance: DeclaredArtifactProvenance;
}>;

export type PreparedDeclaredArtifactReview = Readonly<{
  reviewAfterChild: () => Promise<string>;
  readWithReceiptAfterChild: (
    input?: Readonly<{
      declaredRedactionValues?: readonly string[] | undefined;
    }>,
  ) => Promise<DeclaredArtifactRead>;
  getReceipt: () => DeclaredArtifactReceipt | undefined;
  dispose: () => Promise<void>;
}>;

export type CustomRunnerRuntimePort = Readonly<{
  sessionId: string;
  authorizationProjectDir: string;
  sourceEnv: NodeJS.ProcessEnv;
  authorizationPathEnv?: string | undefined;
  authorizationPathExt?: string | undefined;
  createStage: (
    sourceProjectDir: string,
    role: 'planner' | 'implementer',
  ) => Promise<CustomRunnerStage>;
  admission: CustomRunnerAdmissionPolicy;
  cleanupStaleArtifactReviews: () => Promise<void>;
  beginDeclaredArtifactReview: (
    input: BeginDeclaredArtifactReviewInput,
  ) => Promise<PreparedDeclaredArtifactReview>;
}>;

export type RuntimeExecutionReceipt = Readonly<{
  /** The admitted CLI binary; a backend that owns no executable records none. */
  executablePath?: string | undefined;
  version: string;
  runtimeDigest: string;
  protocolDigest: string;
}>;

/**
 * The prepared planner call: preparation launches nothing, so the members a
 * launch would observe — argument vector, working directory, credential copy,
 * environment fingerprint, session scope — are not part of the record; the
 * planner adapter prepares them at dispatch.
 */
export type PreparedPlannerInvocation = Readonly<{
  runtime: RuntimeExecutionReceipt;
  role: 'planner-read-only';
  transport: PlannerArtifactTransport;
  terminalContract: string;
  capabilityDigest: string;
}>;
