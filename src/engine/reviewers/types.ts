import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { PlannerOutputCallbacks, TypedCallContext } from '../planners/types.js';
import type { TypedSeatCall } from '../runners/typed-output.js';

/**
 * The review seat: one stateless, read-only call over the run diff. It holds no
 * session, writes no file, and returns both the verdict and the fix work.
 * Deliberately narrower than a planner — a reviewer cannot run the planning session, escalate, resume a session or write files.
 * A planner satisfies it structurally, so it can hold the seat unadapted.
 * Seat identity for user-facing messages comes from the config accessor that
 * resolved the seat (`resolveReviewerRunner`), not from the runner: no runner
 * backend carries its own tool or model, so a failing review reports the
 * identity its call site resolved.
 */
export interface Reviewer {
  review(
    prompt: string,
    projectDir: string,
    callbacks: PlannerOutputCallbacks,
  ): Promise<{ text: string; usage: TokenDelta | null }>;
  /** The binding a typed review call reaches this seat through. */
  typedCall(ctx: TypedCallContext): TypedSeatCall;
}
