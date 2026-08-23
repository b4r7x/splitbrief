import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { PlannerOutputCallbacks } from '../planners/types.js';

/**
 * The review seat: one stateless, read-only call. Deliberately narrower than a
 * planner — a reviewer cannot plan, escalate, resume a session or write files.
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
}
