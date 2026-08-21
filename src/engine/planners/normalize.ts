import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
  type PlannerArtifactTransport,
} from '../../core/schemas/task-compilation.js';
import { sha256Hex } from '../../utils/sha256.js';
import { error } from '../../utils/error.js';
import type { PlannerArtifactLogicalName, PlannerInvokeResult, PhaseResult } from './types.js';
import type { RunnerCallContext } from '../calls/types.js';
import { requireCompletedCall } from './require-completed-call.js';

/**
 * Normalizes one current physical call into its owned phase bytes. Only the
 * completed authoritative result of this call supplies text; a failed result
 * yields no phase bytes and no file is reopened — the adapter has already
 * bound the bytes to the attempt receipt.
 */
export function normalizePlannerPhase(input: {
  result: PlannerInvokeResult;
  callContext: RunnerCallContext;
  logicalName: PlannerArtifactLogicalName;
  text: string;
  rawOutput?: string | undefined;
}): PhaseResult {
  const result = requireCompletedCall(input.result);
  const transport: PlannerArtifactTransport = result.transport ??
    input.callContext.transport ?? { kind: 'stdout-final' };
  const attemptId = input.callContext.attemptId ?? createTaskCompilationAttemptId();
  const runtimeReceipt = sha256Hex(
    JSON.stringify({
      callId: result.callId,
      status: result.status,
      text: result.text,
      usage: result.usage,
      artifacts: result.artifacts,
    }),
  );
  let semanticId = `planner-artifact-${result.callId}-${input.logicalName}`;
  let programId: string | null = null;
  let batchId: string | null = null;
  const sourceReceipt =
    transport.kind === 'stdout-final'
      ? { kind: 'stdout-final' as const, resultDigest: runtimeReceipt }
      : (() => {
          const receipt = input.result.ownedArtifactReceipt;
          const leasePath = transport.lease.relativePath ?? transport.lease.path;
          if (
            receipt === undefined ||
            receipt.attemptId !== attemptId ||
            receipt.leaseId !== transport.lease.leaseId ||
            (leasePath !== undefined && receipt.relativePath !== leasePath)
          ) {
            throw error(
              'custom-planner-artifact-invalid',
              'Configured custom planner artifact is missing an attempt-bound lease receipt.',
            );
          }
          semanticId = receipt.semanticId;
          programId = receipt.programId;
          batchId = receipt.batchId;
          return {
            kind: 'declared-file' as const,
            leaseId: receipt.leaseId,
            inodeIdentity: receipt.inodeIdentity,
            leaseReceiptDigest: receipt.leaseReceiptDigest,
          };
        })();
  const artifact = OwnedPlannerArtifactSchema.parse({
    semanticId,
    programId,
    batchId,
    attemptId,
    logicalName: input.logicalName,
    transport: transport.kind,
    text: input.text,
    byteLength: Buffer.byteLength(input.text, 'utf8'),
    sha256: sha256Hex(input.text),
    runtimeReceipt,
    terminal: {
      status: 'completed',
      recordId: result.callId,
      protocolDigest: runtimeReceipt,
    },
    sourceReceipt,
  });
  return {
    artifact,
    ...(input.rawOutput === undefined ? {} : { rawOutput: input.rawOutput }),
  };
}
