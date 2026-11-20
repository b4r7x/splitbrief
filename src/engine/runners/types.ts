import type { TieredApprovalRequest, TieredApprovalResponse } from '../../core/approval/types.js';
import type { ChangedFilesSnapshot } from '../../core/schemas/workflow/changed-files.js';
import { MAX_DECLARED_ARTIFACT_BYTES } from '../../core/schemas/planner-artifact.js';
import type {
  RunnerCallTextChannel,
  RUNNER_CALL_WARNING_SEVERITIES,
  RUNNER_CALL_WARNING_SURFACES,
} from '../../core/schemas/runner-call.js';
import type { RunnerCallTextSemantics } from '../calls/types.js';
import type {
  PlannerArtifactTransport,
  PlannerArtifactAttemptId,
  PlannerArtifactBatchId,
  PlannerArtifactProgramId,
  PlannerArtifactSemanticId,
} from '../../core/schemas/planner-artifact.js';
import type { UsageLimitWindow } from '../../core/recovery/usage-limit-step.js';

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
  /**
   * The raw model ids a fallback or refusal frame names (its wire
   * `original_model`/`fallback_model`). The message stays as the provider wrote
   * it; a consumer that can look the ids up in the runner's catalog spells
   * those names instead, and keeps the raw id when the lookup misses.
   */
  originalModel?: string | undefined;
  fallbackModel?: string | undefined;
  usage?:
    | {
        window: UsageLimitWindow;
        step: number;
        resetsAt?: number | undefined;
      }
    | undefined;
}

export type ParsedTextChannel = RunnerCallTextChannel;
export type ParsedTextSemantics = RunnerCallTextSemantics;

export type ParsedLine =
  | {
      text: string;
      channel?: ParsedTextChannel | undefined;
      isResult?: boolean | undefined;
      isError?: boolean | undefined;
      sessionId?: string | undefined;
      resolvedModel?: string | undefined;
      subagentId?: string | undefined;
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
      isResult?: undefined;
      isError?: boolean | undefined;
      sessionId?: string | undefined;
      resolvedModel?: string | undefined;
      subagentId?: string | undefined;
      toolUse?: ToolUseInfo[] | undefined;
      toolUseStart?: ToolUseInfo[] | undefined;
      toolUseDelta?: ToolUseDeltaInfo[] | undefined;
      toolUseDone?: ToolUseInfo[] | undefined;
      warning?: ParsedWarningInfo[] | undefined;
      isHeartbeat?: boolean | undefined;
    };

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
