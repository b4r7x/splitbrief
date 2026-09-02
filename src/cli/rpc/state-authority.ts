import { z } from 'zod';
import { BriefRecoveryProjectionV1Schema } from '../../core/schemas/brief-recovery/document.js';
import { isBriefReviewCommandCurrent } from '../../core/schemas/brief-review-command.js';
import { envelopeError, type RpcEnvelopeError } from './envelope.js';
import type { RpcCommand } from './types.js';
import { isRecord } from '../../utils/type-guards.js';

const CURRENT_STATE_VERSION = 4;

const CurrentV4StateSchema = z
  .object({
    stateVersion: z.literal(CURRENT_STATE_VERSION),
    projection: BriefRecoveryProjectionV1Schema,
  })
  .strict();

export function validateAgainstAuthority(
  command: RpcCommand,
  getAuthoritativeState: (() => unknown) | undefined,
  requireCurrentV4: boolean,
): RpcEnvelopeError | null {
  if (command.type !== 'brief_review') return null;
  let rawState: unknown | null;
  try {
    rawState = getAuthoritativeState?.() ?? null;
  } catch {
    return envelopeError(
      'malformed-state',
      'RPC command state could not be read from the authoritative host.',
    );
  }
  if (rawState === null) {
    return requireCurrentV4
      ? envelopeError(
          'authority-unavailable',
          'Brief review command requires the authoritative current-v4 projection.',
        )
      : null;
  }

  const parsed = CurrentV4StateSchema.safeParse(rawState);
  if (!parsed.success) {
    const stateVersion = isRecord(rawState) ? rawState.stateVersion : undefined;
    if (stateVersion === 3) {
      return envelopeError(
        'legacy-state',
        'RPC command state is v3 and requires current-v4 authority.',
      );
    }
    if (typeof stateVersion === 'number' && stateVersion > CURRENT_STATE_VERSION) {
      return envelopeError(
        'future-state',
        'RPC command state is newer than the current v4 reader.',
        {
          stateVersion,
        },
      );
    }
    return envelopeError(
      'malformed-state',
      'RPC command state is not a valid current-v4 projection.',
    );
  }

  const projection = parsed.data.projection;
  const reviewCommand = command.command;
  if (reviewCommand.sessionId !== projection.sessionId) {
    return envelopeError(
      'stale-session',
      'RPC command session does not match the current projection.',
    );
  }
  if (!isBriefReviewCommandCurrent(reviewCommand, projection)) {
    if (reviewCommand.epochId !== projection.epochId) {
      return envelopeError(
        'stale-epoch',
        'RPC command epoch does not match the current projection.',
      );
    }
    if (reviewCommand.action !== 'status') {
      return envelopeError(
        'stale-revision',
        'RPC command revisions do not match the current projection.',
      );
    }
  }
  if (reviewCommand.action === 'approve' && !projection.allowedActions.includes('approve')) {
    return envelopeError(
      'brief-contract-blocked',
      'Task Brief approval is blocked by the current recovery projection.',
    );
  }
  return null;
}
