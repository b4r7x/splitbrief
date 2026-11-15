import { z } from 'zod';
import { ReviewFindingCountsSchema, SetAsideSchema } from '../../../core/schemas/review/verdict.js';
import { TaskIdSchema } from '../../../core/schemas/task.js';
import { phaseEvent, taskIdArray } from './fields.js';

export const ReviewEventSchemas = [
  phaseEvent('review_fix_started').extend({
    /** The fix cycles so far that ran a fix brief: the count the user reads. */
    cycle: z.number().int(),
    taskIds: taskIdArray,
  }),
  phaseEvent('review_started').extend({
    scope: z.enum(['final', 'task']),
    /** The brief that scheduled a task review; an anchor, not `taskId` or the reviewed scope. */
    afterTaskId: z.string().optional(),
    tool: z.string(),
    model: z.string().optional(),
    axes: z.array(z.string()).optional(),
  }),
  phaseEvent('review_completed').extend({
    scope: z.enum(['final', 'task']),
    afterTaskId: z.string().optional(),
    tool: z.string(),
    model: z.string().optional(),
    axes: z.array(z.string()).optional(),
    /** The reviewer's outcome; failed/empty calls are `no-verdict`, stops are `stopped`. Both omit findings. */
    verdict: z.enum(['pass', 'pass-with-notes', 'fail', 'no-verdict', 'stopped']),
    findings: ReviewFindingCountsSchema.optional(),
    /** What failed the review: each blocking finding and each red input that still blocks. */
    blockingFindings: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
    /** Each red input the reviewer rejected, with its reason; it no longer blocks the review. */
    setAside: z.array(SetAsideSchema).optional(),
    duration: z.number(),
  }),
  phaseEvent('review_step').extend({
    step: z.enum(['verdict']),
  }),
  /** Why no reviewer check runs before the final review: the checks are off, or the plan names no project gate. */
  phaseEvent('review_checks').extend({
    status: z.enum(['off', 'none']),
  }),
  /**
   * One command run before a review: a reviewer check (`id`) or, in a session from before the
   * reviewer chose them, a full-suite stage (`stage`). `base` is its run at the run base, beside
   * the build; `brief` is a fix brief's reviewer check, with no base re-run. `plan` is a plan check before review.
   * `verify` is a check the review reads or runs to verify a claim, or a check the planner re-runs
   * on a review without progress, with no base re-run.
   */
  phaseEvent('full_suite').extend({
    /**
     * The transcript settles a command a stop cut. A base command runs beside the build, so the
     * engine settles it itself, `stopped` when it cut it. `off` is a fix brief's reviewer check
     * that does not run while End-of-run checks are off.
     */
    status: z.enum(['running', 'done', 'not-run', 'refused', 'stopped', 'off']),
    stage: z.enum(['typecheck', 'lint', 'test']).optional(),
    id: z.string().optional(),
    /** On a plan check a brief's own checks run during the build: the brief. */
    taskId: TaskIdSchema.optional(),
    command: z.string(),
    moment: z.enum(['pre-review', 'base', 'brief', 'plan', 'verify']),
    scenario: z.string().optional(),
    /**
     * On a red check's running update. A red check waits on the run base: a reviewer check on the
     * base run of its id, a plan or task check on the gate command of the same command text.
     */
    waitsOnBase: z.literal(true).optional(),
    passed: z.boolean().optional(),
    /**
     * On a red reviewer check's or verify check's done event (on base done events in an older run),
     * the red run's failure keys that are new, also red at the run base, or red at the run base too
     * without proof that it is the same failure (`notVerified`). A verify check names no failure
     * keys and no `notVerified`.
     */
    newFailures: z.number().int().nonnegative().optional(),
    preExisting: z.number().int().nonnegative().optional(),
    notVerified: z.number().int().nonnegative().optional(),
    /**
     * On the same done events with a verified split, the first failing tests that are new and those
     * also red at the run base (`BASE_SPLIT_NAMED` per side); the counts above say how many more.
     */
    newKeys: z.array(z.string()).optional(),
    preExistingKeys: z.array(z.string()).optional(),
    /**
     * On fix check done events: the brief's own failures, those still present, those left to the
     * unfinished sibling fix tasks `deferredTo`, and the re-run failures the brief does not own.
     */
    own: z.number().int().nonnegative().optional(),
    ownLeft: z.number().int().nonnegative().optional(),
    deferred: z.number().int().nonnegative().optional(),
    deferredTo: z.array(z.string()).optional(),
    others: z.number().int().nonnegative().optional(),
    /**
     * Why the command did not run or was refused; on a red reviewer check (a red base re-run in an
     * older run), why SPLITBRIEF could not verify that the run base shows the same failure.
     */
    detail: z.string().optional(),
    duration: z.number().optional(),
    /** On done events: nothing ran, the result came from the run of the same command at this ISO time. */
    reusedAt: z.string().optional(),
    /** The command hit its time limit. */
    timedOut: z.literal(true).optional(),
  }),
] as const;
